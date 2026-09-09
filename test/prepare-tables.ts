import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { makeMigrationStore, SqliteMigrations } from "effect-domains/sqlite-migrations"
import type { Table } from "effect-domains/table"

export const prepareTables = Effect.fn("test.prepareTables")(function* (tables: ReadonlyArray<Table>) {
  const to = SqliteMigrations.snapshot(tables)
  const empty = SqliteMigrations.snapshot([])
  const initial = SqliteMigrations.plan({ id: "initial", from: empty, to })
  const sql = yield* SqlClient.SqlClient
  yield* makeMigrationStore(sql, [initial]).prepare(to.tables)
})
