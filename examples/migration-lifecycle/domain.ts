import { Schema } from "effect"

export const NonNegativePrioritySchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
)

export const DocumentSchema = Schema.Struct({
  heading: Schema.NonEmptyString,
  summary: Schema.NullOr(Schema.String),
  priority: NonNegativePrioritySchema,
})

interface Document extends Schema.Schema.Type<typeof DocumentSchema> {}
