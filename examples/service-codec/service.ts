import { Context } from "effect"
import type { CommandService } from "effect-domains/application"
import type { NotesCommands } from "./contracts.ts"

export class Notes extends Context.Service<
  Notes,
  CommandService<typeof NotesCommands>
>()("examples/service-codec/Notes") {}
