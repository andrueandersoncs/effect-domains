import { Application } from "effect-domains/application"
import { NotesResource } from "./resources.ts"

export const NotesApplication = Application.make({
  name: "service-codec",
  resources: [NotesResource],
  commands: [],
})
