import { Effect, Option, pipe } from "effect"
import { SqlClient, SqlSchema } from "effect/unstable/sql"
import { BooksService } from "./contracts.ts"
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
type SqliteRow = Readonly<Record<string, unknown>>

const persistenceFailure = () => BookPersistenceError.make({})

const createBook = SqlSchema.findOne({
  Request: BookSchema,
  Result: BookResource.table.rowSchema,
  execute: Effect.fn("Books.create.implementation")(function* (book) {
    const database = yield* SqlClient.SqlClient

    return yield* pipe(
      database<SqliteRow>`
        INSERT INTO ${database(BookResource.table.name)} ${database.insert(book)}
        RETURNING *
      `,
      Effect.mapError(persistenceFailure),
    )
  }),
})

const findBook = SqlSchema.findOneOption({
  Request: BookIdentifierInputSchema,
  Result: BookResource.table.rowSchema,
  execute: Effect.fn("Books.get.implementation")(function* (input) {
    const database = yield* SqlClient.SqlClient

    return yield* pipe(
      database<SqliteRow>`
        SELECT * FROM ${database(BookResource.table.name)}
        WHERE ${database(BookResource.table.identifier)} = ${input.id}
        LIMIT 1
      `,
      Effect.mapError(persistenceFailure),
    )
  }),
})

const listBooks = SqlSchema.findAll({
  Request: ListBooksInputSchema,
  Result: BookResource.table.rowSchema,
  execute: Effect.fn("Books.list.implementation")(function* () {
    const database = yield* SqlClient.SqlClient
    return yield* pipe(
      database<SqliteRow>`SELECT * FROM ${database(BookResource.table.name)}`,
      Effect.mapError(persistenceFailure),
    )
  }),
})

const updateBook = SqlSchema.findOneOption({
  Request: BookResource.table.rowSchema,
  Result: BookResource.table.rowSchema,
  execute: Effect.fn("Books.update.implementation")(function* (input) {
    const database = yield* SqlClient.SqlClient
    const changes = database.update(input, [BookResource.table.identifier])

    return yield* pipe(
      database<SqliteRow>`
        UPDATE ${database(BookResource.table.name)}
        SET ${changes}
        WHERE ${database(BookResource.table.identifier)} = ${input.id}
        RETURNING *
      `,
      Effect.mapError(persistenceFailure),
    )
  }),
})

const removeBook = SqlSchema.findOneOption({
  Request: BookIdentifierInputSchema,
  Result: BookResource.table.rowSchema,
  execute: Effect.fn("Books.remove.implementation")(function* (input) {
    const database = yield* SqlClient.SqlClient

    return yield* pipe(
      database<SqliteRow>`
        DELETE FROM ${database(BookResource.table.name)}
        WHERE ${database(BookResource.table.identifier)} = ${input.id}
        RETURNING *
      `,
      Effect.mapError(persistenceFailure),
    )
  }),
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

const create = Effect.fn("Books.create")(function* (input: Book) {
  return yield* pipe(createBook(input), Effect.mapError(persistenceFailure))
})

const get = Effect.fn("Books.get")(function* (input: BookIdentifierInput) {
  const found = yield* pipe(findBook(input), Effect.mapError(persistenceFailure))
  return yield* requireBook(input.id, found)
})

const list = Effect.fn("Books.list")(function* (input: ListBooksInput) {
  return yield* pipe(listBooks(input), Effect.mapError(persistenceFailure))
})

const update = Effect.fn("Books.update")(function* (
  input: typeof BookResource.table.rowSchema.Type,
) {
  const found = yield* pipe(updateBook(input), Effect.mapError(persistenceFailure))
  return yield* requireBook(input.id, found)
})

const remove = Effect.fn("Books.remove")(function* (input: BookIdentifierInput) {
  const found = yield* pipe(removeBook(input), Effect.mapError(persistenceFailure))
  return yield* requireBook(input.id, found)
})

export const BooksSqlite = BooksService.layer({
  "books.create": create,
  "books.get": get,
  "books.list": list,
  "books.update": update,
  "books.remove": remove,
})
