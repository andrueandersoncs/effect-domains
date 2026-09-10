import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ArticleSchema } from "./domain.ts"

export const DocumentsResource = Resource.make({
  authorization: Authorization.public,
  name: "documents",
  schema: ArticleSchema,
  operations: Resource.crud,
})
