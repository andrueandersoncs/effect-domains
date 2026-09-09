import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { NoteSchema } from "./domain.ts"
import { StoredNoteSchema } from "./storage.ts"

export const NotesResource = Resource.make({ authorization: Authorization.public, name: "notes", schema: NoteSchema, storage: StoredNoteSchema, operations: Resource.crud })
