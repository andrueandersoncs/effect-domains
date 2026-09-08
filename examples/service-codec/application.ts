import { Application } from "effect-domains/application"
import { NotesCommands } from "./contracts.ts"
import { NotesResource } from "./resources.ts"
import { Notes } from "./service.ts"

export const NotesApplication = Application.make({
  name: "service-codec",
  resources: [NotesResource],
  commands: NotesCommands,
})

export const NotesHandlers = NotesApplication.toLayer(Notes)
