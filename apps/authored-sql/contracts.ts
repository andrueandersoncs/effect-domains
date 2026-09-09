import { Schema } from "effect"
import { RpcGroup } from "effect/unstable/rpc"
import { Commands } from "effect-domains/commands"
import { BookSchema } from "@effect-domains/example-support/book"
import {
  BookIdentifierInputSchema,
  BookNotFound,
  BookPersistenceError,
  ListBooksInputSchema,
} from "./domain.ts"
import { BookResource } from "./resources.ts"

const requiredBookErrorsSchema = Schema.Union([
  BookNotFound,
  BookPersistenceError,
])

const StoredBooksSchema = Schema.Array(BookResource.table.rowSchema)

const createBook = Commands.rpc("books.create", {
  payload: BookSchema,
  success: BookResource.table.rowSchema,
  error: BookPersistenceError,
})

const getBook = Commands.rpc("books.get", {
  payload: BookIdentifierInputSchema,
  success: BookResource.table.rowSchema,
  error: requiredBookErrorsSchema,
})

const listBooks = Commands.rpc("books.list", {
  payload: ListBooksInputSchema,
  success: StoredBooksSchema,
  error: BookPersistenceError,
})

const updateBook = Commands.rpc("books.update", {
  payload: BookResource.table.rowSchema,
  success: BookResource.table.rowSchema,
  error: requiredBookErrorsSchema,
})

const removeBook = Commands.rpc("books.remove", {
  payload: BookIdentifierInputSchema,
  success: BookResource.table.rowSchema,
  error: requiredBookErrorsSchema,
})

const booksServiceRpcs = RpcGroup.make(
  createBook,
  getBook,
  listBooks,
  updateBook,
  removeBook,
)

export const BooksService = Commands.make({
  name: "apps/authored-sql/BooksService",
  group: booksServiceRpcs,
})
