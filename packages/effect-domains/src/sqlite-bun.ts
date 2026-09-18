import { SqliteClient } from "@effect/sql-sqlite-bun"

import { makeSqliteRuntime } from "./sqlite-runtime.ts"


const bunSqliteLayer = (filename: string) => SqliteClient.layer({ filename })

export const SqliteBunRuntime = makeSqliteRuntime(bunSqliteLayer)
