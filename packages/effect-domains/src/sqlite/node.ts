import { SqliteClient } from "@effect/sql-sqlite-node"

import { sqliteRuntime } from "./runtime.ts"


const nodeSqliteLayer = (filename: string) => SqliteClient.layer({ filename })

export const SqliteNodeRuntime = sqliteRuntime(nodeSqliteLayer)
