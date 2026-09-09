import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Array, Context, DateTime, Effect, Equivalence, Function, HashMap, Layer, Option, Record, Ref, Schema, pipe } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"

import {
  RepositoryError,
  type RepositoryListCursor,
  RepositoryListOrder,
  RepositoryStore,
  type RepositoryAccess,
} from "./repository-store.ts"

import { PolicySql } from "./policy-sql.ts"
import { Policy, PolicyEnvironment } from "./policy.ts"
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

const unknownEquals = Equivalence.strictEqual<unknown>()
const repositoryOrderDirectionEquals = Equivalence.strictEqual<RepositoryListOrder["direction"]>()
const absentPolicyValue = Option.none<Readonly<Record<string, unknown>>>()

const whereFragment = (sql: SqlClient.SqlClient) => ([field, value]: readonly [string, unknown]) =>
  unknownEquals(value, null) ? sql`${sql(field)} IS NULL` : sql`${sql(field)} = ${value}`

const cursorCondition = (
  sql: SqlClient.SqlClient,
  order: ReadonlyArray<RepositoryListOrder>,
) => (cursor: RepositoryListCursor) => {
  const values = Array.append(cursor.values, cursor.identifier)
  const valueAt = (position: number) => pipe(Array.get(values, position), Option.getOrUndefined)

  const terms = Array.map(order, (entry, index) => {
    const preceding = Array.take(order, index)

    const equalPreceding = Array.map(preceding, (field, position) => {
      const value = valueAt(position)
      return sql`${sql(field.field)} = ${value}`
    })

    const ascending = repositoryOrderDirectionEquals(entry.direction, "asc")
    const operator = sql.literal(ascending ? ">" : "<")
    const value = valueAt(index)
    const boundary = sql`${sql(entry.field)} ${operator} ${value}`
    return sql.and([...equalPreceding, boundary])
  })

  return sql.or(terms)
}

const orderingFragment = (sql: SqlClient.SqlClient) => (entry: RepositoryListOrder) => {
  const ascending = repositoryOrderDirectionEquals(entry.direction, "asc")
  const direction = sql.literal(ascending ? "ASC" : "DESC")
  return sql`${sql(entry.field)} ${direction}`
}

const transactionFailure = (resource: string) => (cause: SqlError.SqlError) =>
  pipe(cause, repositoryFailure(resource), Effect.fail)

const makeRepositoryStore = Effect.fn("RepositoryStore.make")(function* (sqlClient: SqlClient.SqlClient) {
  const policyBinders = yield* pipe(HashMap.empty<Policy, ReturnType<typeof PolicySql.compile>>(), Ref.make)

  const registerPolicy = (policy: Policy) => (registry: HashMap.HashMap<Policy, ReturnType<typeof PolicySql.compile>>) => {
    const cached = HashMap.get(registry, policy)
    if (Option.isSome(cached)) return [cached.value, registry] as const
    const compiled = PolicySql.compile(policy)
    const updated = HashMap.set(registry, policy, compiled)
    return [compiled, updated] as const
  }

  const policyBinding = Effect.fn("RepositoryStore.policyBinding")(
    function* (table: Table, access: RepositoryAccess) {
      const recover = Function.flow(repositoryFailure(table.name), Effect.fail)

      const binder = yield* pipe(
        Ref.modify(policyBinders, registerPolicy(access.policy)),
        Effect.catchDefect(recover),
      )

      const environment = PolicyEnvironment.make({
        subject: access.subject,
        row: absentPolicyValue,
        next: absentPolicyValue,
      })

      return yield* pipe(binder(sqlClient, environment), Effect.mapError(repositoryFailure(table.name)))
    },
  )

  return RepositoryStore.of({
    find: Effect.fn("RepositoryStore.find")(function* (table, key, access) {
      const policy = yield* policyBinding(table, access)

      const rows = yield* pipe(
        sqlClient<Readonly<Record<string, unknown>>>`
          SELECT * FROM ${sqlClient(table.name)}
          WHERE ${policy} AND ${sqlClient(table.identifier)} = ${key}
          LIMIT 1
        `,
        Effect.mapError(repositoryFailure(table.name)),
      )

      return pipe(rows, Array.get(0))
    }),
    list: Effect.fn("RepositoryStore.list")(function* (table, access) {
      const policy = yield* policyBinding(table, access)

      return yield* pipe(
        sqlClient<Readonly<Record<string, unknown>>>`
          SELECT * FROM ${sqlClient(table.name)}
          WHERE ${policy}
        `,
        Effect.mapError(repositoryFailure(table.name)),
      )
    }),
    query: Effect.fn("RepositoryStore.query")(function* (table, query, access) {
      const policy = yield* policyBinding(table, access)
      const identifierOrder = RepositoryListOrder.make({ field: table.identifier, direction: "asc" })
      const order = Array.append(query.order, identifierOrder)
      const filterEntries = Record.toEntries(query.filter)
      const predicates = [policy, ...Array.map(filterEntries, whereFragment(sqlClient))]

      const predicatesWithCursor = Option.match(query.cursor, {
        onNone: Function.constant(predicates),
        onSome: (cursor) => {
          const predicate = cursorCondition(sqlClient, order)(cursor)
          return Array.append(predicates, predicate)
        },
      })

      const ordering = Array.map(order, orderingFragment(sqlClient))

      const rows = yield* pipe(
        sqlClient<Readonly<Record<string, unknown>>>`
          SELECT * FROM ${sqlClient(table.name)}
          WHERE ${sqlClient.and(predicatesWithCursor)}
          ORDER BY ${sqlClient.csv(ordering)}
          LIMIT ${query.limit + 1}
        `,
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
    update: Effect.fn("RepositoryStore.update")(function* (table, value, access) {
      const key = value[table.identifier]
      const policy = yield* policyBinding(table, access)

      const rows = yield* pipe(
        sqlClient<Readonly<Record<string, unknown>>>`
          UPDATE ${sqlClient(table.name)}
          SET ${sqlClient.update(value as Record<string, unknown>, [table.identifier])}
          WHERE ${policy} AND ${sqlClient(table.identifier)} = ${key}
          RETURNING *
        `,
        Effect.mapError(repositoryFailure(table.name)),
      )

      return pipe(rows, Array.get(0))
    }),
    remove: Effect.fn("RepositoryStore.remove")(function* (table, key, access) {
      const policy = yield* policyBinding(table, access)

      const rows = yield* pipe(
        sqlClient<Readonly<Record<string, unknown>>>`
          DELETE FROM ${sqlClient(table.name)}
          WHERE ${policy} AND ${sqlClient(table.identifier)} = ${key}
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
})

const runtimeValues = Value.of({
  uuidV7: () => Effect.sync(() => Bun.randomUUIDv7()),
  now: () => DateTime.now,
})

const values = Layer.succeed(Value, runtimeValues)

const migrationStore = (
  options: Readonly<{ migrations: ReadonlyArray<SqliteMigration> }>,
) => (sql: SqlClient.SqlClient) => makeMigrationStore(sql, options.migrations)

const enableForeignKeys = (context: Context.Context<SqlClient.SqlClient>) => {
  const sql = Context.get(context, SqlClient.SqlClient)

  return pipe(
    sql`PRAGMA foreign_keys = ON`,
    Effect.asVoid,
  )
}

const sqlClient = (
  filename: string,
  options: Readonly<{ migrations: ReadonlyArray<SqliteMigration> }>,
) => {
  const repositoryStore = Effect.flatMap(SqlClient.SqlClient, makeRepositoryStore)
  const migrationStoreEffect = Effect.map(SqlClient.SqlClient, migrationStore(options))
  const repositoryLayer = Layer.effect(RepositoryStore, repositoryStore)
  const schemaStoreLayer = Layer.effect(SchemaStore, migrationStoreEffect)
  const stores = Layer.mergeAll(repositoryLayer, schemaStoreLayer, values)

  const database = pipe(
    SqliteClient.layer({ filename }),
    Layer.tap(enableForeignKeys),
  )

  return Layer.provideMerge(stores, database)
}

export const SqliteBunRuntime = {
  sqlClient,
  values,
}
