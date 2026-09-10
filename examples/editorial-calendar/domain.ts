import { Schema } from "effect"

export const EditorialChannelSchema = Schema.Literals(["website", "newsletter", "print"])

export const NonNegativePrioritySchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
)

export const ArticleSchema = Schema.Struct({
  heading: Schema.NonEmptyString,
  summary: Schema.NullOr(Schema.String),
  priority: NonNegativePrioritySchema,
  channel: EditorialChannelSchema,
  plannedPublicationAt: Schema.NullOr(Schema.DateTimeUtcFromString),
})

interface Article extends Schema.Schema.Type<typeof ArticleSchema> {}
