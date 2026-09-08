import { Context } from "effect"
import type { CommandService } from "effect-domains/application"
import type { BookCommands } from "./contracts.ts"

export class BooksService extends Context.Service<
  BooksService,
  CommandService<typeof BookCommands>
>()("examples/basic-crud/BooksService") {}
