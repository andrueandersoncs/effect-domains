import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { sqliteMigrationStore, SqliteMigrations } from "effect-domains/sqlite-migrations"

export const prepareTables = Effect.fn("test.prepareTables")(function* (tables: Parameters<typeof SqliteMigrations.initial>[0]["tables"]) {
  const initial = SqliteMigrations.initial({ id: "initial", tables })
  const sql = yield* SqlClient.SqlClient

  yield* sqliteMigrationStore(sql, [initial]).prepare(initial.to.tables)
})
