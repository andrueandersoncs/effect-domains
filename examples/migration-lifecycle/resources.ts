import { Resource } from "effect-domains/resource"
import { DocumentSchema } from "./domain.ts"

export const DocumentsResource = Resource.make({
  name: "documents",
  schema: DocumentSchema,
  operations: ["get", "list", "create", "update", "remove"],
})
