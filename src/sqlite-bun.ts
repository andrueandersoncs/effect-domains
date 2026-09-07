import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Array, Context, Effect, Equivalence, Layer, Option, pipe, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { RepositoryError, RepositoryStore } from "./repository-store.ts"
import { SchemaStore } from "./migrations.ts"
import { renderCreateTable } from "./sqlite-ddl.ts"
import { makeMigrationStore, type SqliteMigration } from "./sqlite-migrations.ts"
import { Table, TableError, TableStore } from "./table.ts"

export class Database extends Context.Service<Database, SqlClient.SqlClient>()(
  "@effect-domains/SqliteBun/Database",
) {}

const makeTableStore = (sqlClient: SqlClient.SqlClient) =>
  TableStore.of({
    write: Effect.fn("TableStore.write")(function* (table) {
      const snapshot = Table.snapshot(table)
      const statement = renderCreateTable(snapshot)
      const createTable = sqlClient`${sqlClient.literal(statement)}`

      const tableError = (cause: unknown) => TableError.make({
        operation: "createTable",
        table: table.name,
        cause,
      })

      return yield* pipe(
        createTable,
        Effect.asVoid,
        Effect.mapError(tableError),
      )
    }),
  })

const repositoryFailure = (resource: string) => (cause: unknown) =>
  RepositoryError.make({ resource, cause })

class InsertWithoutReturnedRow extends Schema.TaggedError<InsertWithoutReturnedRow>()(
  "InsertWithoutReturnedRow",
  {},
) {}

const makeRepositoryStore = (sqlClient: SqlClient.SqlClient) =>
  RepositoryStore.of({
    find: Effect.fn("RepositoryStore.find")(function* (table, key) {
      const rows = yield* pipe(
        sqlClient<Readonly<Record<string, unknown>>>`
          SELECT * FROM ${sqlClient(table.name)}
          WHERE ${sqlClient(table.identifier)} = ${key}
          LIMIT 1
        `,
        Effect.mapError(repositoryFailure(table.name)),
      )

      return pipe(rows, Array.get(0))
    }),
    list: Effect.fn("RepositoryStore.list")(function* (table) {
      return yield* pipe(
        sqlClient<Readonly<Record<string, unknown>>>`SELECT * FROM ${sqlClient(table.name)}`,
        Effect.mapError(repositoryFailure(table.name)),
      )
    }),
    insert: Effect.fn("RepositoryStore.insert")(function* (table, value) {
      const rows = yield* pipe(
        sqlClient<Readonly<Record<string, unknown>>>`
          INSERT INTO ${sqlClient(table.name)} ${sqlClient.insert(value as Record<string, unknown>)}
          RETURNING *
        `,
        Effect.mapError(repositoryFailure(table.name)),
      )

      const row = pipe(rows, Array.get(0))
      return yield* Option.match(row, {
        onNone: () => {
          const noRow = InsertWithoutReturnedRow.make({})
          const failure = repositoryFailure(table.name)
          const repositoryError = failure(noRow)

          return Effect.fail(repositoryError)
        },
        onSome: Effect.succeed,
      })
    }),
    update: Effect.fn("RepositoryStore.update")(function* (table, value) {
      const key = value[table.identifier]

      const rows = yield* pipe(
        sqlClient<Readonly<Record<string, unknown>>>`
          UPDATE ${sqlClient(table.name)}
          SET ${sqlClient.update(value as Record<string, unknown>, [table.identifier])}
          WHERE ${sqlClient(table.identifier)} = ${key}
          RETURNING *
        `,
        Effect.mapError(repositoryFailure(table.name)),
      )

      return pipe(rows, Array.get(0))
    }),
    remove: Effect.fn("RepositoryStore.remove")(function* (table, key) {
      const rows = yield* pipe(
        sqlClient<Readonly<Record<string, unknown>>>`
          DELETE FROM ${sqlClient(table.name)}
          WHERE ${sqlClient(table.identifier)} = ${key}
          RETURNING ${sqlClient(table.identifier)}
        `,
        Effect.mapError(repositoryFailure(table.name)),
      )

      return Array.isReadonlyArrayNonEmpty(rows)
    }),
  })

const sqlClient = (
  filename: string,
  options: Readonly<{ migrations: ReadonlyArray<SqliteMigration> }>,
) => {
  const clientLayer = SqliteClient.layer({ filename })
  const databaseLayer = Layer.effect(Database, SqlClient.SqlClient)
  const tableStore = pipe(Database, Effect.map(makeTableStore))

  const tableStoreLayer = Layer.effect(
    TableStore,
    tableStore,
  )

  const repositoryStore = pipe(Database, Effect.map(makeRepositoryStore))

  const repositoryStoreLayer = Layer.effect(
    RepositoryStore,
    repositoryStore,
  )

  const makeSchemaStore = (sqlClient: SqlClient.SqlClient) =>
    makeMigrationStore(sqlClient, options.migrations)

  const schemaStore = pipe(Database, Effect.map(makeSchemaStore))

  const schemaStoreLayer = Layer.effect(
    SchemaStore,
    schemaStore,
  )

  const storesLayer = Layer.mergeAll(
    tableStoreLayer,
    repositoryStoreLayer,
    schemaStoreLayer,
  )

  const servicesLayer = Layer.provideMerge(storesLayer, databaseLayer)

  return Layer.provide(servicesLayer, clientLayer)
}

export const SqliteBunRuntime = {
  sqlClient,
}
