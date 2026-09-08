import { Schema } from "effect"
import type { CommandContracts } from "effect-domains/application"
import {
  EmptyInputSchema,
  NoteIdInputSchema,
  NoteNotFound,
  NoteSchema,
  NotesPersistenceFailure,
} from "./domain.ts"

const noteErrorSchema = Schema.Union([NoteNotFound, NotesPersistenceFailure])
const NotesSchema = Schema.Array(NoteSchema)

export const NotesCommands = {
  "notes.create": {
    input: NoteSchema,
    output: NoteSchema,
    error: NotesPersistenceFailure,
  },
  "notes.get": {
    input: NoteIdInputSchema,
    output: NoteSchema,
    error: noteErrorSchema,
  },
  "notes.list": {
    input: EmptyInputSchema,
    output: NotesSchema,
    error: NotesPersistenceFailure,
  },
  "notes.update": {
    input: NoteSchema,
    output: NoteSchema,
    error: noteErrorSchema,
  },
  "notes.remove": {
    input: NoteIdInputSchema,
    output: Schema.Void,
    error: noteErrorSchema,
  },
} satisfies CommandContracts
