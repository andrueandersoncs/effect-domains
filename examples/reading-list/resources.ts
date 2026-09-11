import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ReadingListBookSchema } from "./domain.ts"

export const ReadingListResource = Resource.make({
  authorization: Authorization.public,
  name: "books",
  schema: ReadingListBookSchema,
  operations: {
    ...Resource.crud,
    list: {
      filter: ["status", "format"],
      limit: 25,
    },
  },
})
