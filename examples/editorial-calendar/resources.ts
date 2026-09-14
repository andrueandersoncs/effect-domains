import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ArticleSchema } from "./domain.ts"

const documentCapabilities = Resource.crud()

export const DocumentsResource = Resource.define({
  authorization: Authorization.public,
  name: "documents",
  schema: ArticleSchema,
  capabilities: documentCapabilities,
})
