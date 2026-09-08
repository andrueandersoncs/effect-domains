import { Schema } from "effect"

export const BookSchema = Schema.Struct({
  title: Schema.String,
  pageCount: Schema.Number,
})

export interface Book extends Schema.Schema.Type<typeof BookSchema> {}
export const ListBooksInputSchema = Schema.Struct({})

export interface ListBooksInput extends Schema.Schema.Type<
  typeof ListBooksInputSchema
> {}

export const BookIdSchema = Schema.String.check(Schema.isUUID(7))

export const BookIdentifierInputSchema = Schema.Struct({ id: BookIdSchema })

export interface BookIdentifierInput extends Schema.Schema.Type<
  typeof BookIdentifierInputSchema
> {}

export class BookNotFound extends Schema.TaggedError<BookNotFound>()(
  "BookNotFound",
  { id: BookIdSchema },
) {}

export class BookPersistenceError extends Schema.TaggedError<BookPersistenceError>()(
  "BookPersistenceError",
  {},
) {}
