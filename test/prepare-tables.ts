import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { makeMigrationStore, SqliteMigrations } from "../src/sqlite-migrations.ts"
import type { Table } from "../src/table.ts"

export const prepareTables = Effect.fn("test.prepareTables")(function* (tables: ReadonlyArray<Table>) {
  const to = SqliteMigrations.snapshot(tables)
  const initial = SqliteMigrations.plan({ id: "initial", from: SqliteMigrations.snapshot([]), to })
  const sql = yield* SqlClient.SqlClient
  yield* makeMigrationStore(sql, [initial]).prepare(to.tables)
})
