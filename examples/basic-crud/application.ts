import { Application } from "effect-domains/application"
import { BooksService } from "./contracts.ts"
import { BookResource } from "./resources.ts"

export const BasicCrudApplication = Application.make({
  name: "basic-crud",
  resources: [BookResource],
  commands: [BooksService],
})
