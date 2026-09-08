import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Array, DateTime, Effect, Layer, pipe } from "effect"
import { SqlClient, SqlError, type Statement } from "effect/unstable/sql"
import { RepositoryError, RepositoryStore, type RepositoryListQuery } from "./repository-store.ts"
import { SchemaStore } from "./migrations.ts"
import { makeMigrationStore, type SqliteMigration } from "./sqlite-migrations.ts"
import type { Table } from "./table.ts"
import { Value } from "./value.ts"


const repositoryFailure = (resource: string) => (cause: unknown) =>
  RepositoryError.make({ resource, cause })


const queryStatement = (
  sql: SqlClient.SqlClient,
  table: Table,
  query: RepositoryListQuery,
) => {
  const order = [...query.order, { field: table.identifier, direction: "asc" as const }]
  const predicates: Array<Statement.Fragment> = Object.entries(query.filter).map(([field, value]) =>
    value === null ? sql`${sql(field)} IS NULL` : sql`${sql(field)} = ${value}`,
  )
  if (query.cursor !== undefined) {
    const values = [...query.cursor.values, query.cursor.identifier]
    predicates.push(sql.or(order.map((entry, index) => sql.and([
      ...order.slice(0, index).map((preceding, position) =>
        sql`${sql(preceding.field)} = ${values[position]}`,
      ),
      entry.direction === "asc"
        ? sql`${sql(entry.field)} > ${values[index]}`
        : sql`${sql(entry.field)} < ${values[index]}`,
    ]))))
  }
  const ordering = order.map((entry) =>
    sql`${sql(entry.field)} ${sql.literal(entry.direction === "asc" ? "ASC" : "DESC")}`,
  )
  return sql<Readonly<Record<string, unknown>>>`
    SELECT * FROM ${sql(table.name)}
    WHERE ${sql.and(predicates)}
    ORDER BY ${sql.csv(ordering)}
    LIMIT ${query.limit + 1}
  `
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

      const row = rows[0]
      return row === undefined
        ? yield* RepositoryError.make({ resource: table.name, cause: new Error("Insert returned no row") })
        : row
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
  const stores = Layer.mergeAll(
    Layer.effect(RepositoryStore, Effect.map(SqlClient.SqlClient, makeRepositoryStore)),
    Layer.effect(SchemaStore, Effect.map(SqlClient.SqlClient, (sql) => makeMigrationStore(sql, options.migrations))),
    values,
  )
  return Layer.provideMerge(stores, SqliteClient.layer({ filename }))
}

export const SqliteBunRuntime = {
  sqlClient,
  values,
}
