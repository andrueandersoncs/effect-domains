import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { DocumentSchema } from "./domain.ts"

export const DocumentsResource = Resource.make({ authorization: Authorization.public, name: "documents", schema: DocumentSchema, operations: Resource.crud })
