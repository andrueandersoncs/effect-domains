import { Array, Effect, Layer, Option, pipe, Schema } from "effect"
import { Query } from "effect-domains/query"
import { Database } from "effect-domains/sqlite-bun"
import { BooksService } from "./books.ts"
import {
  type Book,
  type BookIdentifierInput,
  type ListBooksInput,
  BookIdentifierInputSchema,
  BookNotFound,
  BookPersistenceError,
  BookSchema,
  ListBooksInputSchema,
} from "./domain.ts"
import { BookResource } from "./resources.ts"

const OptionalStoredBookSchema = Schema.OptionFromNullOr(
  BookResource.table.rowSchema,
)

const StoredBooksSchema = Schema.Array(BookResource.table.rowSchema)

type SqliteRow = Readonly<Record<string, unknown>>

const persistenceFailure = () => BookPersistenceError.make({})

const firstRow = Effect.fn("Books.firstRow")(function* (
  rows: ReadonlyArray<SqliteRow>,
) {
  const row = pipe(rows, Array.get(0))
  if (Option.isNone(row)) {
    return yield* persistenceFailure()
  }

  return row.value
})

const createBook = Effect.fn("Books.create.implementation")(function* (
  book: typeof BookSchema.Encoded,
) {
  const database = yield* Database

  const rows = yield* pipe(
    database<SqliteRow>`
      INSERT INTO ${database(BookResource.table.name)} ${database.insert(book)}
      RETURNING *
    `,
    Effect.mapError(persistenceFailure),
  )

  return yield* firstRow(rows)
})

const CreateBook = Query.make({
  table: BookResource.table,
  Request: BookSchema,
  Result: BookResource.table.rowSchema,
  implementation: createBook,
})

const findBook = Effect.fn("Books.get.implementation")(function* (
  input: typeof BookIdentifierInputSchema.Encoded,
) {
  const database = yield* Database

  const rows = yield* pipe(
    database<SqliteRow>`
      SELECT * FROM ${database(BookResource.table.name)}
      WHERE ${database(BookResource.table.identifier)} = ${input.id}
      LIMIT 1
    `,
    Effect.mapError(persistenceFailure),
  )

  return pipe(rows, Array.get(0), Option.getOrNull)
})

const FindBook = Query.make({
  table: BookResource.table,
  Request: BookIdentifierInputSchema,
  Result: OptionalStoredBookSchema,
  implementation: findBook,
})

const listBooks = Effect.fn("Books.list.implementation")(function* () {
  const database = yield* Database
  return yield* pipe(
    database<SqliteRow>`SELECT * FROM ${database(BookResource.table.name)}`,
    Effect.mapError(persistenceFailure),
  )
})

const ListBooks = Query.make({
  table: BookResource.table,
  Request: ListBooksInputSchema,
  Result: StoredBooksSchema,
  implementation: listBooks,
})

const updateBook = Effect.fn("Books.update.implementation")(function* (
  input: typeof BookResource.table.rowSchema.Encoded,
) {
  const database = yield* Database
  const changes = database.update(input, [BookResource.table.identifier])

  const rows = yield* pipe(
    database<SqliteRow>`
      UPDATE ${database(BookResource.table.name)}
      SET ${changes}
      WHERE ${database(BookResource.table.identifier)} = ${input.id}
      RETURNING *
    `,
    Effect.mapError(persistenceFailure),
  )

  return pipe(rows, Array.get(0), Option.getOrNull)
})

const UpdateBook = Query.make({
  table: BookResource.table,
  Request: BookResource.table.rowSchema,
  Result: OptionalStoredBookSchema,
  implementation: updateBook,
})

const removeBook = Effect.fn("Books.remove.implementation")(function* (
  input: typeof BookIdentifierInputSchema.Encoded,
) {
  const database = yield* Database

  const rows = yield* pipe(
    database<SqliteRow>`
      DELETE FROM ${database(BookResource.table.name)}
      WHERE ${database(BookResource.table.identifier)} = ${input.id}
      RETURNING *
    `,
    Effect.mapError(persistenceFailure),
  )

  return pipe(rows, Array.get(0), Option.getOrNull)
})

const RemoveBook = Query.make({
  table: BookResource.table,
  Request: BookIdentifierInputSchema,
  Result: OptionalStoredBookSchema,
  implementation: removeBook,
})

const requireBook = Effect.fn("Books.require")(function* (
  id: (typeof BookIdentifierInputSchema.Type)["id"],
  book: Option.Option<typeof BookResource.table.rowSchema.Type>,
) {
  if (Option.isNone(book)) {
    return yield* BookNotFound.make({ id })
  }

  return book.value
})

const booksSqliteEffect = Effect.gen(function* () {
  const database = yield* Database
  const provideDatabase = Effect.provideService(Database, database)

  const create = Effect.fn("Books.create")(function* (input: Book) {
    return yield* pipe(
      CreateBook.execute(input),
      provideDatabase,
      Effect.mapError(persistenceFailure),
    )
  })

  const get = Effect.fn("Books.get")(function* (input: BookIdentifierInput) {

    const found = yield* pipe(
      FindBook.execute(input),
      provideDatabase,
      Effect.mapError(persistenceFailure),
    )

    return yield* requireBook(input.id, found)
  })

  const list = Effect.fn("Books.list")(function* (input: ListBooksInput) {
    return yield* pipe(
      ListBooks.execute(input),
      provideDatabase,
      Effect.mapError(persistenceFailure),
    )
  })

  const update = Effect.fn("Books.update")(function* (
    input: typeof BookResource.table.rowSchema.Type,
  ) {

    const found = yield* pipe(
      UpdateBook.execute(input),
      provideDatabase,
      Effect.mapError(persistenceFailure),
    )

    return yield* requireBook(input.id, found)
  })

  const remove = Effect.fn("Books.remove")(function* (
    input: BookIdentifierInput,
  ) {

    const found = yield* pipe(
      RemoveBook.execute(input),
      provideDatabase,
      Effect.mapError(persistenceFailure),
    )

    return yield* requireBook(input.id, found)
  })

  return BooksService.of({
    "books.create": create,
    "books.get": get,
    "books.list": list,
    "books.update": update,
    "books.remove": remove,
  })
})

export const BooksSqlite = Layer.effect(BooksService, booksSqliteEffect)
