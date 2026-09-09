import { Schema } from "effect"

export const BookSchema = Schema.Struct({
  title: Schema.String,
  pageCount: Schema.Number,
})

interface Book extends Schema.Schema.Type<typeof BookSchema> {}
