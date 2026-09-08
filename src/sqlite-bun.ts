import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Array, Context, DateTime, Effect, Equivalence, Layer, Option, pipe, Schema } from "effect"
import { SqlClient, SqlError, Statement } from "effect/unstable/sql"
import { RepositoryError, RepositoryStore } from "./repository-store.ts"
import { SchemaStore } from "./migrations.ts"
import { renderCreateTable } from "./sqlite-ddl.ts"
import { makeMigrationStore, type SqliteMigration } from "./sqlite-migrations.ts"
import { Table, TableError, TableStore } from "./table.ts"
import { Value } from "./value.ts"

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

const queryStatement = (
  sqlClient: SqlClient.SqlClient,
  table: Table,
  query: import("./repository-store.ts").RepositoryListQuery,
) => {
  const segments: Array<Statement.Segment> = [
    Statement.literal("SELECT * FROM "),
    Statement.identifier(table.name),
  ]
  const where = () => {
    const filters = Object.entries(query.filter)
    if (filters.length === 0 && query.cursor === undefined) return

    segments.push(Statement.literal(" WHERE "))
    const pushAnd = (index: number) => {
      if (index > 0) segments.push(Statement.literal(" AND "))
    }

    filters.forEach(([field, value], index) => {
      pushAnd(index)
      segments.push(Statement.identifier(field))
      if (value === null) {
        segments.push(Statement.literal(" IS NULL"))
      } else {
        segments.push(Statement.literal(" = "), Statement.parameter(value))
      }
    })

    if (query.cursor === undefined) return
    if (filters.length > 0) segments.push(Statement.literal(" AND "))
    segments.push(Statement.literal("("))

    query.order.forEach((order, index) => {
      if (index > 0) segments.push(Statement.literal(" OR "))
      segments.push(Statement.literal("("))
      query.order.slice(0, index).forEach((preceding, precedingIndex) => {
        if (precedingIndex > 0) segments.push(Statement.literal(" AND "))
        segments.push(
          Statement.identifier(preceding.field),
          Statement.literal(" = "),
          Statement.parameter(query.cursor!.values[precedingIndex]),
        )
      })
      if (index > 0) segments.push(Statement.literal(" AND "))
      segments.push(
        Statement.identifier(order.field),
        Statement.literal(order.direction === "asc" ? " > " : " < "),
        Statement.parameter(query.cursor!.values[index]),
        Statement.literal(")"),
      )
    })

    if (query.order.length > 0) segments.push(Statement.literal(" OR ("))
    query.order.forEach((order, index) => {
      if (index > 0) segments.push(Statement.literal(" AND "))
      segments.push(
        Statement.identifier(order.field),
        Statement.literal(" = "),
        Statement.parameter(query.cursor!.values[index]),
      )
    })
    if (query.order.length > 0) segments.push(Statement.literal(" AND "))
    segments.push(
      Statement.identifier(table.identifier),
      Statement.literal(" > "),
      Statement.parameter(query.cursor.identifier),
      Statement.literal(")"),
    )
    if (query.order.length > 0) segments.push(Statement.literal(")"))
  }

  where()
  segments.push(Statement.literal(" ORDER BY "))
  query.order.forEach((order, index) => {
    if (index > 0) segments.push(Statement.literal(", "))
    segments.push(
      Statement.identifier(order.field),
      Statement.literal(order.direction === "asc" ? " ASC" : " DESC"),
    )
  })
  if (query.order.length > 0) segments.push(Statement.literal(", "))
  segments.push(Statement.identifier(table.identifier), Statement.literal(" ASC LIMIT "), Statement.parameter(query.limit + 1))

  return sqlClient<Readonly<Record<string, unknown>>>`${Statement.fragment(segments)}`
}
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
    query: Effect.fn("RepositoryStore.query")(function* (table, query) {
      const rows = yield* pipe(
        queryStatement(sqlClient, table, query),
        Effect.mapError(repositoryFailure(table.name)),
      )

      return {
        rows: rows.slice(0, query.limit),
        hasMore: rows.length > query.limit,
      }
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
    transaction: Effect.fn("RepositoryStore.transaction")(function* (table, effect) {
      return yield* pipe(
        sqlClient.withTransaction(effect),
        Effect.mapError((cause) =>
          SqlError.isSqlError(cause) ? repositoryFailure(table.name)(cause) : cause,
        ),
      )
    }),
  })
const values = Layer.succeed(
  Value,
  Value.of({
    uuidV7: () => Effect.sync(() => Bun.randomUUIDv7()),
    now: () => DateTime.now,
  }),
)

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

  const servicesLayer = Layer.mergeAll(
    Layer.provideMerge(storesLayer, databaseLayer),
    values,
  )

  return Layer.provide(servicesLayer, clientLayer)
}

export const SqliteBunRuntime = {
  sqlClient,
  values,
}
