import { Array, Effect, Equivalence, Option, pipe, Predicate, Record, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SchemaStore } from "./migrations.ts"
import { TableSnapshot } from "./table-snapshot-model.ts"
import type { Table as TableDefinition } from "./table-relations.ts"

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

const same = Equivalence.strictEqual<unknown>()

const make = (input: Readonly<{
  id: string
  to: SqliteSchemaSnapshot
  steps: ReadonlyArray<SqliteMigrationStep>
}>) => pipe(SqliteMigration.make(input), validateMigration, Effect.map(freeze), Effect.runSync)

const initial = (options: Readonly<{ id: string; tables: ReadonlyArray<TableDefinition> }>) => {
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

export const decodeHistory = Effect.fn("SqliteMigrations.decodeHistory")(function* (raw: unknown) {
    const legacy = Array.isArray(raw) && Array.some(raw, legacyArtifact)

    if (legacy) return yield* migrationFailure("SQLite migration artifacts must use version 2")

    const migrations = yield* pipe(
      Schema.decodeUnknownEffect(SqliteMigrationHistorySchema)(raw),
      Effect.catch(() => Schema.decodeUnknownEffect(Schema.Array(SqliteMigration))(raw)),
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
  decodeHistory: Effect.fn("SqliteMigrations.decodeHistory")(function* (raw: unknown) {
    return yield* decodeHistory(raw)
  }),
}

export const sqliteMigrationStore = (sql: SqlClient.SqlClient, migrations: ReadonlyArray<SqliteMigration>) => SchemaStore.of({
  prepare: Effect.fn("SqliteMigrations.prepare")(function* (tables) {
      const target = schemaSnapshot(tables)

      yield* Effect.asVoid(sql`PRAGMA foreign_keys = ON`)
      yield* validateSnapshot(target)
      yield* validateHistory(migrations)

      const expectedTarget = historySnapshot(migrations, migrations.length - 1)
      const needsInitialHistory = same(migrations.length, 0) && target.tables.length > 0

      if (needsInitialHistory) {
        return yield* migrationFailure("nonempty application schemas require an initial migration history")
      }

      if (!snapshotEquals(expectedTarget, target)) {
        return yield* migrationFailure("the frozen migration history does not end at the application schema")
      }

      yield* Effect.asVoid(sql`CREATE TABLE IF NOT EXISTS ${sql(LedgerTable)} (position INTEGER PRIMARY KEY NOT NULL, id TEXT UNIQUE NOT NULL, artifact TEXT NOT NULL)`)

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
        const idChanged = !same(recorded.id, migration.id)
        const artifactChanged = !same(recorded.artifact, artifact)

        return idChanged || artifactChanged
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
  }, Effect.mapError(asMigrationFailure("could not prepare SQLite migrations")), Effect.provideService(SqlClient.SqlClient, sql)),
})
