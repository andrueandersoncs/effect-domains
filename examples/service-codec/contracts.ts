import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import {
  EmptyInputSchema,
  NoteIdInputSchema,
  NoteNotFound,
  NoteSchema,
  NotesPersistenceFailure,
} from "./domain.ts"

const noteErrorSchema = Schema.Union([NoteNotFound, NotesPersistenceFailure])
const NotesSchema = Schema.Array(NoteSchema)

const createNote = Rpc.make("notes.create", {
  payload: NoteSchema,
  success: NoteSchema,
  error: NotesPersistenceFailure,
})

const getNote = Rpc.make("notes.get", {
  payload: NoteIdInputSchema,
  success: NoteSchema,
  error: noteErrorSchema,
})

const listNotes = Rpc.make("notes.list", {
  payload: EmptyInputSchema,
  success: NotesSchema,
  error: NotesPersistenceFailure,
})

const updateNote = Rpc.make("notes.update", {
  payload: NoteSchema,
  success: NoteSchema,
  error: noteErrorSchema,
})

const removeNote = Rpc.make("notes.remove", {
  payload: NoteIdInputSchema,
  success: Schema.Void,
  error: noteErrorSchema,
})

export const NotesCommands = RpcGroup.make(
  createNote,
  getNote,
  listNotes,
  updateNote,
  removeNote,
)
