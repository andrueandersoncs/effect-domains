import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ReadingListBookSchema } from "./domain.ts"

export const ReadingListResource = Resource.define({
  authorization: Authorization.public,
  name: "books",
  schema: ReadingListBookSchema,
  capabilities: Resource.capabilities(
    Resource.get(),
    Resource.list({ filter: ["status", "format"], limit: 25 }),
    Resource.create(),
    Resource.update(),
    Resource.remove(),
  ),
})
