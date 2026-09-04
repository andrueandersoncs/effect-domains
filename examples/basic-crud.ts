import { mkdtempDisposableSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Array, Effect, Option, pipe, Schema } from "effect"
import { Query } from "effect-domains/query"
import { Database, SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { Table } from "effect-domains/table"

await pipe(
  Effect.gen(function* () {
    const BookSchema = Schema.Struct({
      title: Schema.String,
      pageCount: Schema.Number,
    })

    interface Book extends Schema.Schema.Type<typeof BookSchema> {}
    const Books = Table.make({ name: "books", schema: BookSchema })

    const createBook = Effect.fn("CreateBook.implementation")(function* (
      book: typeof BookSchema.Type,
    ) {
      const database = yield* Database

      const rows = yield* database<Readonly<Record<string, unknown>>>`
        INSERT INTO ${database(Books.name)} ${database.insert(book)} RETURNING *
      `

      return pipe(rows, Array.get(0), Option.getOrUndefined)
    })

    const CreateBook = Query.make({
      table: Books,
      Request: BookSchema,
      Result: Books.rowSchema,
      implementation: createBook,
    })

    const OptionalStoredBookSchema = Schema.OptionFromNullOr(Books.rowSchema)

    const findBook = Effect.fn("FindBook.implementation")(function* (
      id: typeof Books.identifierSchema.Encoded,
    ) {
      const database = yield* Database

      const rows = yield* database<Readonly<Record<string, unknown>>>`
        SELECT * FROM ${database(Books.name)}
        WHERE ${database(Books.identifier)} = ${id}
        LIMIT 1
      `

      return pipe(rows, Array.get(0), Option.getOrNull)
    })

    const FindBook = Query.make({
      table: Books,
      Request: Books.identifierSchema,
      Result: OptionalStoredBookSchema,
      implementation: findBook,
    })

    const systemTemporaryDirectory = tmpdir()

    const temporaryDirectoryPrefix = join(
      systemTemporaryDirectory,
      "effect-domains-basic-",
    )

    const acquireTemporaryDirectory = Effect.sync(
      () => mkdtempDisposableSync(temporaryDirectoryPrefix),
    )

    const removeFromMkdtempdisposablesync = (
      directory: ReturnType<typeof mkdtempDisposableSync>,
    ) => Effect.sync(directory.remove)

    const directory = yield* Effect.acquireRelease(
      acquireTemporaryDirectory,
      removeFromMkdtempdisposablesync,
    )

    const databasePath = join(directory.path, "example.sqlite")
    const databaseLayer = SqliteBunRuntime.sqlClient(databasePath)

    const operations = Effect.gen(function* () {
      yield* Books.write()

      const book = BookSchema.make({
        title: "A Field Guide",
        pageCount: 120,
      })

      const created = yield* CreateBook.execute(book)
      const found = yield* FindBook.execute(created.id)

      return { created, found: Option.getOrNull(found) }
    })

    const result = yield* pipe(operations, Effect.provide(databaseLayer))

    yield* Effect.log("Query result", result)
  }),
  Effect.scoped,
  Effect.runPromise,
)
