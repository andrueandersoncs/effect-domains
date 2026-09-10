import { Effect, Option, pipe } from "effect"
import { SqlClient, SqlSchema } from "effect/unstable/sql"
import { BookSchema } from "@effect-domains/example-support/book"
import { BooksRpcs } from "./contracts.ts"

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

const persistenceFailures = {
  SqlError: persistenceFailure,
  SchemaError: persistenceFailure,
}

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

const create = Effect.fn("Books.create")(function* (input: typeof BookSchema.Type) {
  return yield* pipe(createBook(input), Effect.catchTags({
    ...persistenceFailures,
    NoSuchElementError: persistenceFailure,
  }))
})

const list = Effect.fn("Books.list")(function* (input: ListBooksInput) {
  return yield* pipe(listBooks(input), Effect.catchTags(persistenceFailures))
})

const get = Effect.fn("Books.get")(function* (input: BookIdentifierInput) {
  const found = yield* pipe(findBook(input), Effect.catchTags(persistenceFailures))
  return yield* requireBook(input.id, found)
})

const update = Effect.fn("Books.update")(function* (
  input: typeof BookResource.table.rowSchema.Type,
) {
  const found = yield* pipe(updateBook(input), Effect.catchTags(persistenceFailures))
  return yield* requireBook(input.id, found)
})

const remove = Effect.fn("Books.remove")(function* (input: BookIdentifierInput) {
  const found = yield* pipe(removeBook(input), Effect.catchTags(persistenceFailures))
  return yield* requireBook(input.id, found)
})

export const BooksSqlite = BooksRpcs.toLayer({
  "books.create": create,
  "books.get": get,
  "books.list": list,
  "books.update": update,
  "books.remove": remove,
})
