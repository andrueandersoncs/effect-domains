import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ReadingListBookSchema } from "./domain.ts"

const readingListCapabilities = [
  Resource.get(),
  Resource.list({ filter: ["status", "format"], limit: 25 }),
  Resource.create(),
  Resource.update(),
  Resource.remove(),
]

export const ReadingListResource = Resource.define({
  authorization: Authorization.public,
  name: "books",
  schema: ReadingListBookSchema,
  capabilities: readingListCapabilities,
})
