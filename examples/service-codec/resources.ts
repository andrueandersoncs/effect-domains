import { Resource } from "effect-domains/resource"
import { NoteSchema } from "./domain.ts"
import { StoredNoteSchema } from "./storage.ts"

export const NotesResource = Resource.make({
  name: "notes",
  schema: NoteSchema,
  storage: StoredNoteSchema,
  operations: Resource.crud,
})
