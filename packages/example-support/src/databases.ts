import { Array, Context, Effect, Equivalence, FileSystem, Function, Layer, Option, Schema, Struct, pipe } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"

class DatabaseConflict extends Schema.TaggedError<DatabaseConflict>()("ExampleDatabaseConflict", {
  application: Schema.String,
  execution: Schema.String,
}) {}

const DatabaseFileSchema = Schema.Struct({ name: Schema.String, file: Schema.String })
interface DatabaseFile extends Schema.Schema.Type<typeof DatabaseFileSchema> {}
const DatabaseFilesSchema = Schema.Array(DatabaseFileSchema)
const equals = Equivalence.strictEqual<unknown>()

const mainFile = Effect.fn("ExampleDatabase.mainFile")(function* (sql: SqlClient.SqlClient) {
  const rows = yield* sql`PRAGMA database_list`
  const databases = yield* Schema.decodeUnknownEffect(DatabaseFilesSchema)(rows)
  const main = Array.findFirst(databases, ({ name }) => equals(name, "main"))
  return pipe(main, Option.map(Struct.get("file")), Option.getOrThrow)
})

// Compare opened files because native execution must not initialize storage in the application database.
const assertDistinctDatabases = Effect.fn("ExampleDatabase.assertDistinct")(function* (
  application: SqlClient.SqlClient,
  execution: SqlClient.SqlClient,
) {
  const applicationFile = yield* mainFile(application)
  const executionFile = yield* mainFile(execution)
  const applicationMemory = !applicationFile
  const executionMemory = !executionFile
  const inMemory = applicationMemory || executionMemory
  if (inMemory) return
  const fs = yield* FileSystem.FileSystem
  const left = yield* fs.stat(applicationFile)
  const right = yield* fs.stat(executionFile)
  const sameInode = pipe(left.ino, Option.zipWith(right.ino, equals), Option.getOrElse(Function.constant(false)))
  const sameDevice = equals(left.dev, right.dev)
  const sameIdentity = sameDevice && sameInode
  const sameFile = equals(applicationFile, executionFile) || sameIdentity
  if (sameFile) return yield* DatabaseConflict.make({ application: applicationFile, execution: executionFile })
})

export const privateSqlite = (filename: string) => pipe(Effect.gen(function* () {
  const applicationSql = yield* SqlClient.SqlClient

  const verifyDatabase = (context: Context.Context<SqlClient.SqlClient>) => {
    const executionSql = Context.get(context, SqlClient.SqlClient)
    return assertDistinctDatabases(applicationSql, executionSql)
  }

  return pipe(
    SqliteClient.layer({ filename }),
    Layer.tap(verifyDatabase),
  )
}), Layer.unwrap)
