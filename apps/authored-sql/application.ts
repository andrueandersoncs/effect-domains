import { Application } from "effect-domains/application"
import { BooksRpcs } from "./contracts.ts"
import { BookResource } from "./resources.ts"
import { BooksSqlite } from "./sqlite.ts"

export const AuthoredSqlApplication = Application.make({
  name: "authored-sql",
  parts: [BookResource, { group: BooksRpcs, handlers: BooksSqlite }],
})
