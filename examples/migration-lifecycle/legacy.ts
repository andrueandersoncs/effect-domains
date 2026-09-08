import { Schema } from "effect"
import { Resource } from "effect-domains/resource"

export const LegacyDocumentSchema = Schema.Struct({
  title: Schema.NonEmptyString,
})

interface LegacyDocument extends Schema.Schema.Type<
  typeof LegacyDocumentSchema
> {}

export const LegacyDocumentsResource = Resource.make({
  name: "documents",
  schema: LegacyDocumentSchema,
  operations: [],
})
