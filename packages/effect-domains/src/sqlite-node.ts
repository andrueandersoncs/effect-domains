import { SqliteClient } from "@effect/sql-sqlite-node"

import { makeSqliteRuntime } from "./sqlite-runtime.ts"


const nodeSqliteLayer = (filename: string) => SqliteClient.layer({ filename })

export const SqliteNodeRuntime = makeSqliteRuntime(nodeSqliteLayer)
