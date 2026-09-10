import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { makeMigrationStore, SqliteMigrations } from "effect-domains/sqlite-migrations"
import type { Table } from "effect-domains/table"

export const prepareTables = Effect.fn("test.prepareTables")(function* (tables: ReadonlyArray<Table>) {
  const initial = SqliteMigrations.initial({ id: "initial", tables })
  const sql = yield* SqlClient.SqlClient
  yield* makeMigrationStore(sql, [initial]).prepare(initial.to.tables)
})
