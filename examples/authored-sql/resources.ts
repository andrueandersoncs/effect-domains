import { Resource } from "effect-domains/resource"
import { BookSchema } from "../basic-crud/domain.ts"

export const BookResource = Resource.make({
  name: "books",
  schema: BookSchema,
  operations: [],
})
