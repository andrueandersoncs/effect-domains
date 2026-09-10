import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
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

const createBook = Rpc.make("books.create", {
  payload: BookSchema,
  success: BookResource.table.rowSchema,
  error: BookPersistenceError,
})

const getBook = Rpc.make("books.get", {
  payload: BookIdentifierInputSchema,
  success: BookResource.table.rowSchema,
  error: requiredBookErrorsSchema,
})

const listBooks = Rpc.make("books.list", {
  payload: ListBooksInputSchema,
  success: StoredBooksSchema,
  error: BookPersistenceError,
})

const updateBook = Rpc.make("books.update", {
  payload: BookResource.table.rowSchema,
  success: BookResource.table.rowSchema,
  error: requiredBookErrorsSchema,
})

const removeBook = Rpc.make("books.remove", {
  payload: BookIdentifierInputSchema,
  success: BookResource.table.rowSchema,
  error: requiredBookErrorsSchema,
})

export const BooksRpcs = RpcGroup.make(
  createBook,
  getBook,
  listBooks,
  updateBook,
  removeBook,
)
