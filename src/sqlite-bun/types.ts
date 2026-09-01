import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Function, Layer, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { TableStore } from "../table/services.ts"
import { tableStoreFromSqlclient } from "./algorithms.ts"
import { Database } from "./services.ts"

const sqlClient = (filename: string) => {
  const options = Function.identity({ filename })
  const clientLayer = SqliteClient.layer(options)

  const databaseLayer = pipe(
    Layer.effect(Database, SqlClient.SqlClient),
    Layer.provide(clientLayer),
  )

  const tableStore = Effect.map(Database, tableStoreFromSqlclient)

  const tableStoreLayer = pipe(
    Layer.effect(TableStore, tableStore),
    Layer.provide(databaseLayer),
  )

  return Layer.merge(databaseLayer, tableStoreLayer)
}

/**
 *
 * Scope: public
 *
 * When to use: An application needs Bun SQLite services because authored
 * queries and table writes share one runtime.
 *
 * Example:
 * ```ts
 * import { Effect } from "effect"
 * import { SqliteBunRuntime } from "effect-domains/sqlite-bun/types"
 *
 * const databaseLayer = SqliteBunRuntime.sqlClient("app.sqlite")
 * const program = Effect.void.pipe(Effect.provide(databaseLayer))
 * ```
 *
 */
export class SqliteBunRuntime {
  private constructor() {}

  static sqlClient = sqlClient
}
