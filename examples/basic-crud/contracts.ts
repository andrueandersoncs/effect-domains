import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Commands } from "effect-domains/commands"
import {
  BookIdentifierInputSchema,
  BookNotFound,
  BookPersistenceError,
  BookSchema,
  ListBooksInputSchema,
} from "./domain.ts"
import { BookResource } from "./resources.ts"

const requiredBookErrorsSchema = Schema.Union([
  BookNotFound,
  BookPersistenceError,
])

const StoredBooksSchema = Schema.Array(BookResource.table.rowSchema)

const bookWireSchema = Schema.toCodecJson(BookSchema)
const storedBookWireSchema = Schema.toCodecJson(BookResource.table.rowSchema)
const storedBooksWireSchema = Schema.toCodecJson(StoredBooksSchema)
const identifierWireSchema = Schema.toCodecJson(BookIdentifierInputSchema)
const listInputWireSchema = Schema.toCodecJson(ListBooksInputSchema)
const persistenceErrorWireSchema = Schema.toCodecJson(BookPersistenceError)
const requiredBookErrorsWireSchema = Schema.toCodecJson(requiredBookErrorsSchema)

const createBook = Rpc.make("books.create", {
  payload: bookWireSchema,
  success: storedBookWireSchema,
  error: persistenceErrorWireSchema,
})

const getBook = Rpc.make("books.get", {
  payload: identifierWireSchema,
  success: storedBookWireSchema,
  error: requiredBookErrorsWireSchema,
})

const listBooks = Rpc.make("books.list", {
  payload: listInputWireSchema,
  success: storedBooksWireSchema,
  error: persistenceErrorWireSchema,
})

const updateBook = Rpc.make("books.update", {
  payload: storedBookWireSchema,
  success: storedBookWireSchema,
  error: requiredBookErrorsWireSchema,
})

const removeBook = Rpc.make("books.remove", {
  payload: identifierWireSchema,
  success: storedBookWireSchema,
  error: requiredBookErrorsWireSchema,
})

const bookRpcs = RpcGroup.make(createBook, getBook, listBooks, updateBook, removeBook)

export const BooksService = Commands.make({
  name: "examples/basic-crud/BooksService",
  group: bookRpcs,
})
