import { mkdtempDisposableSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option, pipe, Schema } from "effect"
import { Domain, Query, Table } from "effect-domains"
import * as SqliteBun from "effect-domains/sqlite-bun"

const BookId = pipe(
  Schema.String,
  Schema.brand("BookId"),
  Domain.identifier,
)

const Book = Schema.Struct({
  id: BookId,
  title: Schema.String,
  pageCount: Schema.Number,
})

const Books = Table.make(Book, { name: "books" })

const CreateBook = Query.make(Books, {
  Request: Book,
  Result: Book,
  implementation: (book) =>
    Effect.gen(function* () {
      const db = yield* SqliteBun.Database
      const rows = yield* db<Readonly<Record<string, unknown>>>`
        INSERT INTO ${db(Books.name)} ${db.insert(book)} RETURNING *
      `
      return rows[0]
    }),
})

const FindBook = Query.make(Books, {
  Request: BookId,
  Result: Schema.OptionFromNullOr(Book),
  implementation: (id) =>
    Effect.gen(function* () {
      const db = yield* SqliteBun.Database
      const rows = yield* db<Readonly<Record<string, unknown>>>`
        SELECT * FROM ${db(Books.name)}
        WHERE ${db(Books.identifier)} = ${id}
        LIMIT 1
      `
      return rows[0] ?? null
    }),
})

const temporaryDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempDisposableSync(join(tmpdir(), "effect-domains-basic-"))),
  (directory) => Effect.sync(() => directory.remove()),
)

const program = Effect.gen(function* () {
  const directory = yield* temporaryDirectory
  const Live = SqliteBun.layer(
    new SqliteBun.SqliteBunOptions(join(directory.path, "example.sqlite")),
  )

  const operations = Effect.gen(function* () {
    yield* Books.createTable()

    const id = Schema.decodeUnknownSync(BookId)("book-1")
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
