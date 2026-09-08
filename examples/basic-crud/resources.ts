import { Resource } from "effect-domains/resource"
import { BookSchema } from "./domain.ts"

export const BookResource = Resource.make({
  name: "books",
  schema: BookSchema,
  operations: [],
})
