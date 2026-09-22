import { Array, Context, Effect, Layer, Option, Redacted, Schema, Struct, pipe } from "effect"

import {
  EventGroup,
  EventJournal,
  EventLog,
  EventLogMessage,
  SqlEventJournal,
} from "effect/unstable/eventlog"

import { Reactivity } from "effect/unstable/reactivity"
import { SqlClient } from "effect/unstable/sql"

export const SyncedNoteSchema = Schema.Struct({
  noteId: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  revision: Schema.Natural,
  replicaId: Schema.NonEmptyString,
  conflictsObserved: Schema.Natural,
})

const NoteEditSchema = Schema.Struct({
  noteId: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  revision: Schema.Natural,
  replicaId: Schema.NonEmptyString,
})

export const SyncedNoteEvents = EventGroup.empty.add({
  tag: "NoteEdited",
  primaryKey: ({ noteId }) => noteId,
  payload: NoteEditSchema,
  success: SyncedNoteSchema,
})

export const SyncedNoteEventLog = EventLog.schema(SyncedNoteEvents)

type NoteEdit = typeof NoteEditSchema.Type

class SyncedNoteProjection extends Context.Service<SyncedNoteProjection, {
  readonly apply: (edit: NoteEdit, conflictsObserved: number) => Effect.Effect<typeof SyncedNoteSchema.Type>
  readonly find: (noteId: string) => Effect.Effect<Option.Option<typeof SyncedNoteSchema.Type>>
  readonly clear: Effect.Effect<void>
}>()("@effect-domains/example-field-notes/SyncedNoteProjection") {}

const materializeNote = (note: typeof SyncedNoteSchema.Type) => SyncedNoteSchema.make({
  noteId: note.noteId,
  title: note.title,
  revision: note.revision,
  replicaId: note.replicaId,
  conflictsObserved: note.conflictsObserved,
})

const projectionService = Effect.gen(function* () {
  const database = yield* SqlClient.SqlClient

  yield* database`
    CREATE TABLE IF NOT EXISTS synced_note_projection (
      noteId TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      revision INTEGER NOT NULL,
      replicaId TEXT NOT NULL,
      conflictsObserved INTEGER NOT NULL
    )
  `

  const find = Effect.fn("FieldNotes.Sync.find")(function* (noteId: string) {
    const rows = yield* database<Readonly<typeof SyncedNoteSchema.Type>>`
      SELECT noteId, title, revision, replicaId, conflictsObserved
      FROM synced_note_projection
      WHERE noteId = ${noteId}
    `

    return pipe(Array.get(rows, 0), Option.map(materializeNote))
  }, Effect.orDie)

  const clear = pipe(
    database`DELETE FROM synced_note_projection`,
    Effect.asVoid,
    Effect.orDie,
  )

  const apply = Effect.fn("FieldNotes.Sync.apply")(function* (edit: NoteEdit, conflictsObserved: number) {
    yield* database`
      INSERT INTO synced_note_projection
        (noteId, title, revision, replicaId, conflictsObserved)
      VALUES
        (${edit.noteId}, ${edit.title}, ${edit.revision}, ${edit.replicaId}, ${conflictsObserved})
      ON CONFLICT(noteId) DO UPDATE SET
        title = CASE
          WHEN excluded.revision > revision
            OR (excluded.revision = revision AND excluded.replicaId > replicaId)
          THEN excluded.title ELSE title END,
        revision = CASE
          WHEN excluded.revision > revision
            OR (excluded.revision = revision AND excluded.replicaId > replicaId)
          THEN excluded.revision ELSE revision END,
        replicaId = CASE
          WHEN excluded.revision > revision
            OR (excluded.revision = revision AND excluded.replicaId > replicaId)
          THEN excluded.replicaId ELSE replicaId END,
        conflictsObserved = MAX(conflictsObserved, excluded.conflictsObserved)
    `

    return yield* pipe(find(edit.noteId), Effect.flatMap(Option.match({
      onNone: () => Effect.die(`Synced note projection missing after edit: ${edit.noteId}`),
      onSome: Effect.succeed,
    })))
  }, Effect.orDie)

  return SyncedNoteProjection.of({ apply, find, clear })
})

const projectionLayer = Layer.effect(SyncedNoteProjection, projectionService)

const handlers = EventLog.group(SyncedNoteEvents, (handlers) => handlers.handle(
  "NoteEdited",
  ({ conflicts, payload }) => pipe(
    SyncedNoteProjection,
    Effect.flatMap((projection) => projection.apply(payload, conflicts.length)),
  ),
))

export const syncedNoteReplicaLayer = (replicaId: string) => {
  const privateKeyBytes = new Uint8Array(32)
  const privateKey = Redacted.make(privateKeyBytes)

  const identity = Layer.succeed(EventLog.Identity, {
    publicKey: replicaId,
    privateKey,
  })

  const journal = SqlEventJournal.layer()

  const eventLog = pipe(
    EventLog.layer(SyncedNoteEventLog, handlers),
    Layer.provideMerge(projectionLayer),
    Layer.provideMerge(journal),
    Layer.provideMerge(identity),
  )

  return Layer.mergeAll(eventLog, Reactivity.layer)
}

export const editSyncedNote = Effect.fn("FieldNotes.Sync.edit")(function* (edit: NoteEdit) {
  const write = yield* EventLog.makeClient(SyncedNoteEventLog)

  return yield* write("NoteEdited", edit)
})

const eventLogEntries = Struct.get<EventLog.EventLog["Service"], "entries">("entries")

export const syncedNoteEntries = Effect.fn("FieldNotes.Sync.entries")(function* () {
  const eventLog = yield* EventLog.EventLog

  return yield* eventLogEntries(eventLog)
})()

export const findSyncedNote = Effect.fn("FieldNotes.Sync.findProjected")(function* (noteId: string) {
  const projection = yield* SyncedNoteProjection

  return yield* projection.find(noteId)
})

const remoteEntry = (entry: EventJournal.Entry, remoteSequence: number) => EventJournal.RemoteEntry.make({
  remoteSequence,
  entry,
})

export const syncSyncedNoteEntries = Effect.fn("FieldNotes.Sync.replay")(function* (
  entries: ReadonlyArray<EventJournal.Entry>,
  remoteId: EventJournal.RemoteId,
) {
  const journal = yield* EventJournal.EventJournal
  const registry = yield* EventLog.Registry
  const identity = yield* EventLog.Identity
  const reactivity = yield* Reactivity.Reactivity
  const storeId = EventLogMessage.StoreId.make("default")

  const replay = EventLog.makeReplayFromRemote({
    handlers: registry.handlers,
    storeId,
    identity,
    reactivity,
    reactivityKeys: registry.reactivityKeys,
    logAnnotations: { service: "FieldNotes.Sync", effect: "replay" },
  })

  const remoteEntries = Array.map(entries, remoteEntry)

  return yield* pipe(
    journal.writeFromRemote({ remoteId, entries: remoteEntries, effect: replay }),
    journal.withLock(storeId),
  )
})

export const rebuildSyncedNoteProjection = Effect.fn("FieldNotes.Sync.rebuild")(function* () {
  const eventLog = yield* EventLog.EventLog
  const projection = yield* SyncedNoteProjection
  const registry = yield* EventLog.Registry
  const identity = yield* EventLog.Identity
  const reactivity = yield* Reactivity.Reactivity
  const storeId = EventLogMessage.StoreId.make("default")

  const replay = EventLog.makeReplayFromRemote({
    handlers: registry.handlers,
    storeId,
    identity,
    reactivity,
    reactivityKeys: registry.reactivityKeys,
    logAnnotations: { service: "FieldNotes.Sync", effect: "rebuild" },
  })

  const replayEntry = (entry: EventJournal.Entry) => replay({ entry, conflicts: [] })
  const entries = yield* eventLog.entries

  yield* projection.clear

  yield* Effect.forEach(entries, replayEntry, {
    concurrency: 1,
    discard: true,
  })
})()
