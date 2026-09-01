import { Context } from "effect"
import type { SqlClient } from "effect/unstable/sql"

/**
 *
 * Scope: public
 *
 * When to use: An authored query needs the SQL statement constructor supplied
 * by the active Bun SQLite layer because the operation must retain its runtime
 * requirement.
 *
 * Example:
 * ```ts
 * import { Effect } from "effect"
 * import { Database } from "effect-domains/sqlite-bun/services"
 *
 * const statement = Effect.gen(function* () {
 *   const database = yield* Database
 *   return database`SELECT 1`
 * })
 * ```
 *
 */
export class Database extends Context.Service<Database, SqlClient.SqlClient>()(
  "@effect-domains/SqliteBun/Database",
) {}
