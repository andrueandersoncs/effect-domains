import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { BookSchema } from "@effect-domains/example-support/book"

export const BookResource = Resource.make({ authorization: Authorization.public, name: "books", schema: BookSchema, operations: [] })
