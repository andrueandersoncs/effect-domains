import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ExampleSubjectSchema } from "../authentication.ts"
import { NoteSchema } from "./domain.ts"
import { StoredNoteSchema } from "./storage.ts"

const p = Authorization.for({ resource: NoteSchema, subject: ExampleSubjectSchema })
const allNotes = p.all()
const reader = p.includes(p.subject.roles, "reader")
const editor = p.includes(p.subject.roles, "editor")
const administrator = p.includes(p.subject.roles, "admin")
const readAccess = p.any(reader, editor, administrator)
const writeAccess = p.any(editor, administrator)

const authorization = p.policy({
  scope: allNotes,
  allow: {
    read: readAccess,
    create: writeAccess,
    update: writeAccess,
    remove: administrator,
  },
})

export const NotesResource = Resource.make({
  authorization,
  name: "notes",
  schema: NoteSchema,
  storage: StoredNoteSchema,
  operations: Resource.crud,
})
