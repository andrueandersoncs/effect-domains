import { SqliteClient } from "@effect/sql-sqlite-bun"

import { sqliteRuntime } from "./sqlite-runtime.ts"


const bunSqliteLayer = (filename: string) => SqliteClient.layer({ filename })

export const SqliteBunRuntime = sqliteRuntime(bunSqliteLayer)
