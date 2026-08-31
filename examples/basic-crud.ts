import { mkdtempDisposableSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Array, Effect, Option, pipe, Schema } from "effect"
import { Domain, Query, Table } from "effect-domains"
import * as SqliteBun from "effect-domains/sqlite-bun"

const BookIdSchema = pipe(
  Schema.String,
  Schema.brand("BookId"),
  Domain.identifier,
)

// The decoded BookId type stays distinct because identifiers must retain their brand at compile time.
type BookId = Schema.Schema.Type<typeof BookIdSchema>

const BookSchema = Schema.Struct({
  id: BookIdSchema,
  title: Schema.String,
  pageCount: Schema.Number,
})

// Book names the decoded domain value because the schema also represents its encoded form at runtime.
interface Book extends Schema.Schema.Type<typeof BookSchema> {}

const Books = Table.make(BookSchema, { name: "books" })

const CreateBook = Query.make(Books, {
  Request: BookSchema,
  Result: BookSchema,
  implementation: Effect.fn("CreateBook.implementation")(function* (book) {
    const db = yield* SqliteBun.Database

    const rows = yield* db<Readonly<Record<string, unknown>>>`
      INSERT INTO ${db(Books.name)} ${db.insert(book)} RETURNING *
    `

    const firstRow = Array.get(rows, 0)
    return Option.getOrUndefined(firstRow)
  }),
})

const OptionalBookSchema = Schema.OptionFromNullOr(BookSchema)

const FindBook = Query.make(Books, {
  Request: BookIdSchema,
  Result: OptionalBookSchema,
  implementation: Effect.fn("FindBook.implementation")(function* (id) {
    const db = yield* SqliteBun.Database

    const rows = yield* db<Readonly<Record<string, unknown>>>`
      SELECT * FROM ${db(Books.name)}
      WHERE ${db(Books.identifier)} = ${id}
      LIMIT 1
    `

    const firstRow = Array.get(rows, 0)
    return Option.getOrNull(firstRow)
  }),
})

const systemTemporaryDirectory = tmpdir()
const temporaryDirectoryPrefix = join(systemTemporaryDirectory, "effect-domains-basic-")

const acquireTemporaryDirectory = Effect.sync(
  () => mkdtempDisposableSync(temporaryDirectoryPrefix),
)

const makeRemove = (
  directory: ReturnType<typeof mkdtempDisposableSync>,
) => Effect.sync(directory.remove)

const temporaryDirectory = Effect.acquireRelease(
  acquireTemporaryDirectory,
  makeRemove,
)

const program = Effect.gen(function* () {
  const directory = yield* temporaryDirectory
  const databasePath = join(directory.path, "example.sqlite")
  const databaseOptions = new SqliteBun.SqliteBunOptions(databasePath)
  const Live = SqliteBun.layer(databaseOptions)

  const operations = Effect.gen(function* () {
    yield* Books.createTable()

    const id = BookIdSchema.make("book-1")

    const created = yield* CreateBook.execute({
      id,
      title: "A Field Guide",
      pageCount: 120,
    })

    const found = yield* FindBook.execute(created.id)

    return { created, found: Option.getOrNull(found) }
  })

  const result = yield* pipe(operations, Effect.provide(Live))
  yield* Effect.log("Query result", result)
})

await pipe(program, Effect.scoped, Effect.runPromise)
