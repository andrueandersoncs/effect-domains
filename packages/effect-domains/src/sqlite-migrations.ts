import { Array, Effect, Option, pipe, Predicate, Record, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SchemaStore } from "./migrations.ts"
import { Table, TableSnapshot } from "./table.ts"

import {
  applyMigration,
  SqliteMigrationRowsSchema,
  verifyDatabase,
} from "./sqlite-migration-database.ts"

import {
  asMigrationFailure,
  canonicalText,
  declaredIndexes,
  freeze,
  historySnapshot,
  LedgerTable,
  migrationFailure,
  schemaSnapshot,
  snapshotEquals,
  snapshotFromTable,
  SqliteAddColumn,
  SqliteColumnExpression,
  SqliteColumnSource,
  SqliteColumnValue,
  SqliteCreateIndex,
  SqliteCreateTable,
  SqliteDropIndex,
  SqliteMigration,
  SqliteMigrationHistorySchema,
  type SqliteMigrationStep,
  SqliteRebuildTable,
  SqliteRenameColumn,
  type SqliteSchemaSnapshot,
  validateHistory,
  validateMigration,
  validateSnapshot,
} from "./sqlite-migration-model.ts"

export { SqliteMigration } from "./sqlite-migration-model.ts"


const same = <Value>(left: Value, right: Value): boolean => Object.is(left, right)

const applyStatement = <A, E, R>(statement: Effect.Effect<A, E, R>) =>
  pipe(statement, Effect.asVoid)

const make = (input: Readonly<{
  id: string
  to: SqliteSchemaSnapshot
  steps: ReadonlyArray<SqliteMigrationStep>
}>) => pipe(SqliteMigration.make(input), validateMigration, Effect.map(freeze), Effect.runSync)

const initial = (options: Readonly<{ id: string; tables: ReadonlyArray<Table> }>) => {
  const to = snapshotFromTable(options.tables)
  const createTable = (table: TableSnapshot) => SqliteCreateTable.make({ table: table.name })
  const tables = Array.map(to.tables, createTable)

  const createIndexes = (table: TableSnapshot) => {
    const create = (index: ReturnType<typeof declaredIndexes>[number]) =>
      SqliteCreateIndex.make({ table: table.name, name: index.name })

    return pipe(declaredIndexes(table), Array.map(create))
  }

  const indexes = Array.flatMap(to.tables, createIndexes)

  return make({ id: options.id, to, steps: [...tables, ...indexes] })
}

const legacyArtifact = (artifact: unknown) =>
  Predicate.isObject(artifact) && Record.has(artifact, "from")

const decodeHistory = (raw: unknown) =>
  Effect.gen(function* () {
    const legacy = Array.isArray(raw) && Array.some(raw, legacyArtifact)

    if (legacy) return yield* migrationFailure("SQLite migration artifacts must use version 2")

    const historySchema = Schema.Array(SqliteMigration)
    const decodeCurrent = Schema.decodeUnknownEffect(SqliteMigrationHistorySchema)(raw)
    const decodeLegacy = Schema.decodeUnknownEffect(historySchema)(raw)
    const migrations = yield* pipe(
      decodeCurrent,
      Effect.catch(() => decodeLegacy),
      Effect.mapError(asMigrationFailure("invalid SQLite migration history")),
    )

    return yield* validateHistory(migrations)
  })

const histories = (...artifacts: ReadonlyArray<unknown>) =>
  pipe(artifacts, decodeHistory, Effect.runSync)

/** Explicit migration artifacts. Schema changes and copy semantics are authored, never inferred. */
export const SqliteMigrations = {
  steps: {
    CreateTable: SqliteCreateTable,
    AddColumn: SqliteAddColumn,
    RenameColumn: SqliteRenameColumn,
    RebuildTable: SqliteRebuildTable,
    CreateIndex: SqliteCreateIndex,
    DropIndex: SqliteDropIndex,
  },
  copies: {
    Source: SqliteColumnSource,
    Value: SqliteColumnValue,
    Expression: SqliteColumnExpression,
  },
  make,
  initial,
  snapshot: snapshotFromTable,
  history: histories,
  decodeHistory,
}

export const sqliteMigrationStore = (sql: SqlClient.SqlClient, migrations: ReadonlyArray<SqliteMigration>) => SchemaStore.of({
  prepare: (tables) =>
    Effect.gen(function* () {
      const target = schemaSnapshot(tables)

      yield* applyStatement(sql`PRAGMA foreign_keys = ON`)
      yield* validateSnapshot(target)
      yield* validateHistory(migrations)

      const expectedTarget = historySnapshot(migrations, migrations.length - 1)
      const emptyHistory = same(migrations.length, 0)
      const missingHistory = emptyHistory && target.tables.length > 0

      if (missingHistory) return yield* migrationFailure("nonempty application schemas require an initial migration history")

      if (!snapshotEquals(expectedTarget, target)) {
        return yield* migrationFailure("the frozen migration history does not end at the application schema")
      }

      yield* applyStatement(sql`CREATE TABLE IF NOT EXISTS ${sql(LedgerTable)} (position INTEGER PRIMARY KEY NOT NULL, id TEXT UNIQUE NOT NULL, artifact TEXT NOT NULL)`)

      const ledger = yield* pipe(
        sql`SELECT id, artifact FROM ${sql(LedgerTable)} ORDER BY position`,
        Effect.flatMap(Schema.decodeUnknownEffect(SqliteMigrationRowsSchema)),
        Effect.mapError(asMigrationFailure("could not read SQLite migration history")),
      )

      if (ledger.length > migrations.length) {
        return yield* migrationFailure("SQLite contains migration history not supplied by the application")
      }

      const compared = Array.zip(ledger, migrations)

      const changed = Array.findFirst(compared, ([recorded, migration]) => {
        const artifact = canonicalText(migration)
        const sameId = same(recorded.id, migration.id)
        const sameArtifact = same(recorded.artifact, artifact)
        const unchanged = sameId && sameArtifact

        return !unchanged
      })

      if (Option.isSome(changed)) {
        const [recorded] = changed.value

        return yield* migrationFailure(`migration history changed at ${recorded.id}`)
      }

      const expectedCurrent = historySnapshot(migrations, ledger.length - 1)

      yield* verifyDatabase(sql, expectedCurrent)

      const pending = Array.drop(migrations, ledger.length)

      yield* Effect.forEach(
        pending,
        (migration, index) => {
          const previous = historySnapshot(migrations, ledger.length + index - 1)

          return applyMigration(sql, previous, migration, ledger.length + index)
        },
        { discard: true },
      )

      yield* verifyDatabase(sql, target)
    }).pipe(
      Effect.mapError(asMigrationFailure("could not prepare SQLite migrations")),
      Effect.provideService(SqlClient.SqlClient, sql),
    ),
})
