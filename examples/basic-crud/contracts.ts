import { Schema } from "effect"
import type { CommandContracts } from "effect-domains/application"
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

export const BookCommands = {
  "books.create": {
    input: BookSchema,
    output: BookResource.table.rowSchema,
    error: BookPersistenceError,
  },
  "books.get": {
    input: BookIdentifierInputSchema,
    output: BookResource.table.rowSchema,
    error: requiredBookErrorsSchema,
  },
  "books.list": {
    input: ListBooksInputSchema,
    output: StoredBooksSchema,
    error: BookPersistenceError,
  },
  "books.update": {
    input: BookResource.table.rowSchema,
    output: BookResource.table.rowSchema,
    error: requiredBookErrorsSchema,
  },
  "books.remove": {
    input: BookIdentifierInputSchema,
    output: BookResource.table.rowSchema,
    error: requiredBookErrorsSchema,
  },
} satisfies CommandContracts
