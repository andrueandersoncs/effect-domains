import { Application } from "effect-domains/application"
import { BooksService } from "./contracts.ts"
import { BookResource } from "./resources.ts"

export const AuthoredSqlApplication = Application.make({
  name: "authored-sql",
  resources: [BookResource],
  commands: [BooksService],
})
