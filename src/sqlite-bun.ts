import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Array, DateTime, Effect, Equivalence, Function, Layer, Option, Record, Schema, pipe } from "effect"
import { SqlClient, SqlError, type Statement } from "effect/unstable/sql"
import {
  RepositoryError,
  RepositoryListCursor,
  RepositoryListOrder,
  RepositoryStore,
  type RepositoryListQuery,
} from "./repository-store.ts"
import { SchemaStore } from "./migrations.ts"
import { makeMigrationStore, type SqliteMigration } from "./sqlite-migrations.ts"
import type { Table } from "./table.ts"
import { Value } from "./value.ts"

class InsertReturnedNoRow extends Schema.TaggedError<InsertReturnedNoRow>()(
  "InsertReturnedNoRow",
  {},
) {}

const repositoryFailure = (resource: string) => (cause: unknown) =>
  RepositoryError.make({ resource, cause })

const isEqual = Equivalence.strictEqual<unknown>()
const isAscending = Equivalence.strictEqual<"asc" | "desc">()

const whereFragment = (sql: SqlClient.SqlClient) => ([field, value]: readonly [string, unknown]) => {
  const isNull = isEqual(value, null)
  return isNull ? sql`${sql(field)} IS NULL` : sql`${sql(field)} = ${value}`
}

const leadingEqualitySql = (
  sql: SqlClient.SqlClient,
  values: ReadonlyArray<unknown>,
) => (entry: RepositoryListOrder, position: number) => {
  const valueOption = Array.get(values, position)
  const value = Option.getOrUndefined(valueOption)
  return sql`${sql(entry.field)} = ${value}`
}

const cursorTerm = (
  sql: SqlClient.SqlClient,
  order: ReadonlyArray<RepositoryListOrder>,
  values: ReadonlyArray<unknown>,
) => (entry: RepositoryListOrder, index: number) => {
  const preceding = Array.take(order, index)
  const equalPreceding = Array.map(preceding, leadingEqualitySql(sql, values))
  const valueOption = Array.get(values, index)
  const value = Option.getOrUndefined(valueOption)
  const ascending = isAscending(entry.direction, "asc")

  const boundary = ascending
    ? sql`${sql(entry.field)} > ${value}`
    : sql`${sql(entry.field)} < ${value}`

  return sql.and([...equalPreceding, boundary])
}

const cursorCondition = (
  sql: SqlClient.SqlClient,
  order: ReadonlyArray<RepositoryListOrder>,
) => (cursor: RepositoryListCursor) => {
  const values = Array.append(cursor.values, cursor.identifier)
  const terms = Array.map(order, cursorTerm(sql, order, values))
  return sql.or(terms)
}

const appendCursorCondition = (
  sql: SqlClient.SqlClient,
  order: ReadonlyArray<RepositoryListOrder>,
  predicates: ReadonlyArray<Statement.Fragment>,
) => (cursor: RepositoryListCursor) => {
  const predicate = cursorCondition(sql, order)(cursor)
  return Array.append(predicates, predicate)
}

const orderingFragment = (sql: SqlClient.SqlClient) => (entry: RepositoryListOrder) => {
  const ascending = isAscending(entry.direction, "asc")
  const direction = sql.literal(ascending ? "ASC" : "DESC")
  return sql`${sql(entry.field)} ${direction}`
}

const queryStatement = (
  sql: SqlClient.SqlClient,
  table: Table,
  query: RepositoryListQuery,
) => {
  const identifierOrder = RepositoryListOrder.make({ field: table.identifier, direction: "asc" })
  const order = Array.append(query.order, identifierOrder)
  const filterEntries = Record.toEntries(query.filter)
  const predicates = Array.map(filterEntries, whereFragment(sql))

  const predicatesWithCursor = Option.match(query.cursor, {
    onNone: Function.constant(predicates),
    onSome: appendCursorCondition(sql, order, predicates),
  })

  const ordering = Array.map(order, orderingFragment(sql))

  return sql<Readonly<Record<string, unknown>>>`
    SELECT * FROM ${sql(table.name)}
    WHERE ${sql.and(predicatesWithCursor)}
    ORDER BY ${sql.csv(ordering)}
    LIMIT ${query.limit + 1}
  `
}

const transactionFailure = (resource: string) => (cause: SqlError.SqlError) =>
  pipe(cause, repositoryFailure(resource), Effect.fail)

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
      const statement = queryStatement(sqlClient, table, query)

      const rows = yield* pipe(
        statement,
        Effect.mapError(repositoryFailure(table.name)),
      )

      const page = Array.take(rows, query.limit)
      const hasMore = rows.length > query.limit

      return { rows: page, hasMore }
    }),
    insert: Effect.fn("RepositoryStore.insert")(function* (table, value) {
      const rows = yield* pipe(
        sqlClient<Readonly<Record<string, unknown>>>`
          INSERT INTO ${sqlClient(table.name)} ${sqlClient.insert(value as Record<string, unknown>)}
          RETURNING *
        `,
        Effect.mapError(repositoryFailure(table.name)),
      )

      const row = Array.get(rows, 0)
      if (Option.isNone(row)) {
        return yield* RepositoryError.make({
          resource: table.name,
          cause: InsertReturnedNoRow.make({}),
        })
      }

      return row.value
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
        Effect.catchIf(SqlError.isSqlError, transactionFailure(table.name)),
      )
    }),
  })

const runtimeValues = Value.of({
  uuidV7: () => Effect.sync(() => Bun.randomUUIDv7()),
  now: () => DateTime.now,
})

const values = Layer.succeed(Value, runtimeValues)

const migrationStore = (
  options: Readonly<{ migrations: ReadonlyArray<SqliteMigration> }>,
) => (sql: SqlClient.SqlClient) => makeMigrationStore(sql, options.migrations)

const sqlClient = (
  filename: string,
  options: Readonly<{ migrations: ReadonlyArray<SqliteMigration> }>,
) => {
  const repositoryStore = Effect.map(SqlClient.SqlClient, makeRepositoryStore)
  const migrationStoreEffect = Effect.map(SqlClient.SqlClient, migrationStore(options))
  const repositoryLayer = Layer.effect(RepositoryStore, repositoryStore)
  const schemaStoreLayer = Layer.effect(SchemaStore, migrationStoreEffect)
  const stores = Layer.mergeAll(repositoryLayer, schemaStoreLayer, values)
  const database = SqliteClient.layer({ filename })

  return Layer.provideMerge(stores, database)
}

export const SqliteBunRuntime = {
  sqlClient,
  values,
}
