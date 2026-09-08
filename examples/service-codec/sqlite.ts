import { Array, Context, Effect, Layer, Option, Schema, pipe } from "effect"
import { Query } from "effect-domains/query"
import { Database } from "effect-domains/sqlite-bun"
import {
  type Note,
  EmptyInputSchema,
  type NoteIdInput,
  NoteNotFound,
  NotesPersistenceFailure,
} from "./domain.ts"
import { NotesResource } from "./resources.ts"
import { Notes } from "./service.ts"
import { StoragePrefix, StoredNoteSchema } from "./storage.ts"

const OptionalStoredNoteSchema = Schema.OptionFromNullOr(StoredNoteSchema)
const StoredNotesSchema = Schema.Array(StoredNoteSchema)

const createStoredNote = Effect.fn("Notes.createStored.implementation")(
  function* (note: typeof StoredNoteSchema.Encoded) {
    const database = yield* Database

    const rows = yield* database<Readonly<Record<string, unknown>>>`
    INSERT INTO ${database(NotesResource.table.name)} ${database.insert(note)}
    RETURNING *
  `

    return pipe(rows, Array.get(0), Option.getOrUndefined)
  },
)

const CreateStoredNote = Query.make({
  table: NotesResource.table,
  Request: StoredNoteSchema,
  Result: StoredNoteSchema,
  implementation: createStoredNote,
})

const getStoredNote = Effect.fn("Notes.getStored.implementation")(function* (
  id: typeof NotesResource.table.identifierSchema.Encoded,
) {
  const database = yield* Database

  const rows = yield* database<Readonly<Record<string, unknown>>>`
    SELECT * FROM ${database(NotesResource.table.name)}
    WHERE ${database(NotesResource.table.identifier)} = ${id}
    LIMIT 1
  `

  return pipe(rows, Array.get(0), Option.getOrNull)
})

const GetStoredNote = Query.make({
  table: NotesResource.table,
  Request: NotesResource.table.identifierSchema,
  Result: OptionalStoredNoteSchema,
  implementation: getStoredNote,
})

const listStoredNotes = Effect.fn("Notes.listStored.implementation")(
  function* () {
    const database = yield* Database
    return yield* database<Readonly<Record<string, unknown>>>`
    SELECT * FROM ${database(NotesResource.table.name)}
  `
  },
)

const ListStoredNotes = Query.make({
  table: NotesResource.table,
  Request: EmptyInputSchema,
  Result: StoredNotesSchema,
  implementation: listStoredNotes,
})

const updateStoredNote = Effect.fn("Notes.updateStored.implementation")(
  function* (note: typeof StoredNoteSchema.Encoded) {
    const database = yield* Database

    const rows = yield* database<Readonly<Record<string, unknown>>>`
    UPDATE ${database(NotesResource.table.name)}
    SET ${database.update(note, [NotesResource.table.identifier])}
    WHERE ${database(NotesResource.table.identifier)} = ${note.id}
    RETURNING *
  `

    return pipe(rows, Array.get(0), Option.getOrNull)
  },
)

const UpdateStoredNote = Query.make({
  table: NotesResource.table,
  Request: StoredNoteSchema,
  Result: OptionalStoredNoteSchema,
  implementation: updateStoredNote,
})

const removeStoredNote = Effect.fn("Notes.removeStored.implementation")(
  function* (id: typeof NotesResource.table.identifierSchema.Encoded) {
    const database = yield* Database

    const rows = yield* database`
    DELETE FROM ${database(NotesResource.table.name)}
    WHERE ${database(NotesResource.table.identifier)} = ${id}
    RETURNING ${database(NotesResource.table.identifier)}
  `

    return Array.isReadonlyArrayNonEmpty(rows)
  },
)

const RemoveStoredNote = Query.make({
  table: NotesResource.table,
  Request: NotesResource.table.identifierSchema,
  Result: Schema.Boolean,
  implementation: removeStoredNote,
})

export const createKeepsCodecRequirement =
  true satisfies Context.Service.Identifier<
    typeof StoragePrefix
  > extends Effect.Services<ReturnType<typeof CreateStoredNote.execute>>
    ? true
    : false

const persistenceFailure = (operation: string) => (_cause: unknown) =>
  NotesPersistenceFailure.make({ operation })

const notesSqliteEffect = Effect.gen(function* () {
  const database = yield* Database
  const storagePrefix = yield* StoragePrefix

  const create = Effect.fn("Notes.create")(function* (input: Note) {
    return yield* pipe(
      CreateStoredNote.execute(input),
      Effect.provideService(Database, database),
      Effect.provideService(StoragePrefix, storagePrefix),
      Effect.mapError(persistenceFailure("create")),
    )
  })

  const get = Effect.fn("Notes.get")(function* (input: NoteIdInput) {
    const stored = yield* pipe(
      GetStoredNote.execute(input.id),
      Effect.provideService(Database, database),
      Effect.provideService(StoragePrefix, storagePrefix),
      Effect.mapError(persistenceFailure("get")),
    )

    return yield* Option.match(stored, {
      onNone: () => NoteNotFound.make({ id: input.id }),
      onSome: Effect.succeed,
    })
  })

  const list = Effect.fn("Notes.list")(function* () {
    return yield* pipe(
      ListStoredNotes.execute({}),
      Effect.provideService(Database, database),
      Effect.provideService(StoragePrefix, storagePrefix),
      Effect.mapError(persistenceFailure("list")),
    )
  })

  const update = Effect.fn("Notes.update")(function* (input: Note) {
    const stored = yield* pipe(
      UpdateStoredNote.execute(input),
      Effect.provideService(Database, database),
      Effect.provideService(StoragePrefix, storagePrefix),
      Effect.mapError(persistenceFailure("update")),
    )

    return yield* Option.match(stored, {
      onNone: () => NoteNotFound.make({ id: input.id }),
      onSome: Effect.succeed,
    })
  })

  const remove = Effect.fn("Notes.remove")(function* (input: NoteIdInput) {
    const removed = yield* pipe(
      RemoveStoredNote.execute(input.id),
      Effect.provideService(Database, database),
      Effect.provideService(StoragePrefix, storagePrefix),
      Effect.mapError(persistenceFailure("remove")),
    )

    if (!removed) {
      return yield* NoteNotFound.make({ id: input.id })
    }
  })

  return Notes.of({
    "notes.create": create,
    "notes.get": get,
    "notes.list": list,
    "notes.update": update,
    "notes.remove": remove,
  })
})

export const NotesSqlite = Layer.effect(Notes, notesSqliteEffect)
