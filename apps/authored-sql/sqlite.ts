import { Effect, Option } from "effect"
import { SqlClient, SqlSchema } from "effect/unstable/sql"
import { type Book, BookSchema } from "@effect-domains/example-support/book"
import { BooksService } from "./contracts.ts"
import {
  type BookIdentifierInput,
  type ListBooksInput,
  BookIdentifierInputSchema,
  BookNotFound,
  BookPersistenceError,
  ListBooksInputSchema,
} from "./domain.ts"
import { BookResource } from "./resources.ts"
type SqliteRow = Readonly<Record<string, unknown>>

const persistenceFailure = Effect.fn("Books.persistenceFailure")(function* () {
  return yield* BookPersistenceError.make({})
})

const createBook = SqlSchema.findOne({
  Request: BookSchema,
  Result: BookResource.table.rowSchema,
  execute: Effect.fn("Books.create.implementation")(function* (book) {
    const database = yield* SqlClient.SqlClient

    return yield* database<SqliteRow>`
      INSERT INTO ${database(BookResource.table.name)} ${database.insert(book)}
      RETURNING *
    `
  }),
})

const findBook = SqlSchema.findOneOption({
  Request: BookIdentifierInputSchema,
  Result: BookResource.table.rowSchema,
  execute: Effect.fn("Books.get.implementation")(function* (input) {
    const database = yield* SqlClient.SqlClient

    return yield* database<SqliteRow>`
      SELECT * FROM ${database(BookResource.table.name)}
      WHERE ${database(BookResource.table.identifier)} = ${input.id}
      LIMIT 1
    `
  }),
})

const listBooks = SqlSchema.findAll({
  Request: ListBooksInputSchema,
  Result: BookResource.table.rowSchema,
  execute: Effect.fn("Books.list.implementation")(function* () {
    const database = yield* SqlClient.SqlClient
    return yield* database<SqliteRow>`SELECT * FROM ${database(BookResource.table.name)}`
  }),
})

const updateBook = SqlSchema.findOneOption({
  Request: BookResource.table.rowSchema,
  Result: BookResource.table.rowSchema,
  execute: Effect.fn("Books.update.implementation")(function* (input) {
    const database = yield* SqlClient.SqlClient
    const changes = database.update(input, [BookResource.table.identifier])

    return yield* database<SqliteRow>`
      UPDATE ${database(BookResource.table.name)}
      SET ${changes}
      WHERE ${database(BookResource.table.identifier)} = ${input.id}
      RETURNING *
    `
  }),
})

const removeBook = SqlSchema.findOneOption({
  Request: BookIdentifierInputSchema,
  Result: BookResource.table.rowSchema,
  execute: Effect.fn("Books.remove.implementation")(function* (input) {
    const database = yield* SqlClient.SqlClient

    return yield* database<SqliteRow>`
      DELETE FROM ${database(BookResource.table.name)}
      WHERE ${database(BookResource.table.identifier)} = ${input.id}
      RETURNING *
    `
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

const get = Effect.fn("Books.get")(function* (input: BookIdentifierInput) {
  const found = yield* findBook(input)
  return yield* requireBook(input.id, found)
})

const update = Effect.fn("Books.update")(function* (
  input: typeof BookResource.table.rowSchema.Type,
) {
  const found = yield* updateBook(input)
  return yield* requireBook(input.id, found)
})

const remove = Effect.fn("Books.remove")(function* (input: BookIdentifierInput) {
  const found = yield* removeBook(input)
  return yield* requireBook(input.id, found)
})

export const BooksSqlite = BooksService.layer({
  "books.create": createBook,
  "books.get": get,
  "books.list": listBooks,
  "books.update": update,
  "books.remove": remove,
}, {
  catchTags: {
    SqlError: persistenceFailure,
    SchemaError: persistenceFailure,
    NoSuchElementError: persistenceFailure,
  },
})
