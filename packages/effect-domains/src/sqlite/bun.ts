import { SqliteClient } from "@effect/sql-sqlite-bun"

import { sqliteRuntime } from "./runtime.ts"


const bunSqliteLayer = (filename: string) => SqliteClient.layer({ filename })

export const SqliteBunRuntime = sqliteRuntime(bunSqliteLayer)
