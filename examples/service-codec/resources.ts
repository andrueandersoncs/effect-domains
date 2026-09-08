import { Resource } from "effect-domains/resource"
import { StoredNoteSchema } from "./storage.ts"

export const NotesResource = Resource.make({
  name: "notes",
  schema: StoredNoteSchema,
  operations: [],
})
