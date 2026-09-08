import { Application } from "effect-domains/application"
import { BookCommands } from "./contracts.ts"
import { BooksService } from "./books.ts"
import { BookResource } from "./resources.ts"

export const BasicCrudApplication = Application.make({
  name: "basic-crud",
  resources: [BookResource],
  commands: BookCommands,
})

export const BasicCrudHandlers = BasicCrudApplication.toLayer(BooksService)
