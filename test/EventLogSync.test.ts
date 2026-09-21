import { BunServices } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Path, Schema, pipe } from "effect"
import { EventJournal } from "effect/unstable/eventlog"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"

import { editSyncedNote,
findSyncedNote,
rebuildSyncedNoteProjection,
syncedNoteEntries,
syncedNoteReplicaLayer,
syncSyncedNoteEntries, } from "@effect-domains/example-field-notes/sync"

const readNote = (noteId: string) => pipe(
  findSyncedNote(noteId),
  Effect.map(Option.getOrThrow),
)

it.effect("synchronizes SQL journals and resolves concurrent note edits deterministically", Effect.fn("EventLogSync.replicas")(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fileSystem.makeTempDirectoryScoped()
  const databaseAPath = path.join(directory, "a.sqlite")
  const databaseBPath = path.join(directory, "b.sqlite")
  const databaseA = SqliteBunRuntime.sqlClient(databaseAPath, { migrations: [] })
  const databaseB = SqliteBunRuntime.sqlClient(databaseBPath, { migrations: [] })
  const replicaA = pipe(syncedNoteReplicaLayer("replica-a"), Layer.provide(databaseA))
  const replicaB = pipe(syncedNoteReplicaLayer("replica-b"), Layer.provide(databaseB))
  const contextA = yield* Layer.build(replicaA)
  const contextB = yield* Layer.build(replicaB)
  const runA = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, contextA)
  const runB = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, contextB)
  const editA = editSyncedNote({ noteId: "shared", title: "from a", revision: 1, replicaId: "replica-a" })
  const editB = editSyncedNote({ noteId: "shared", title: "from b", revision: 2, replicaId: "replica-b" })

  yield* runA(editA)
  yield* runB(editB)

  const entriesA = yield* runA(syncedNoteEntries)
  const entriesB = yield* runB(syncedNoteEntries)

  expect(entriesA).toHaveLength(1)
  expect(entriesB).toHaveLength(1)

  const remoteABytes = new Uint8Array(16)
  const remoteBBytes = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
  const remoteA = yield* Schema.decodeUnknownEffect(EventJournal.RemoteId)(remoteABytes)
  const remoteB = yield* Schema.decodeUnknownEffect(EventJournal.RemoteId)(remoteBBytes)
  const syncAIntoB = syncSyncedNoteEntries(entriesA, remoteA)

  yield* runB(syncAIntoB)

  const readFromB = readNote("shared")
  const bAfterConflict = yield* runB(readFromB)

  expect(bAfterConflict).toMatchObject({
    title: "from b",
    revision: 2,
    replicaId: "replica-b",
  })

  expect(bAfterConflict.conflictsObserved).toBeGreaterThan(0)

  const allEntriesB = yield* runB(syncedNoteEntries)
  const syncBIntoA = syncSyncedNoteEntries(allEntriesB, remoteB)
  const firstSync = yield* runA(syncBIntoA)
  const readFromA = readNote("shared")
  const aAfterSync = yield* runA(readFromA)

  expect(firstSync.duplicateEntries).toHaveLength(1)

  expect(aAfterSync).toMatchObject({
    title: "from b",
    revision: 2,
    replicaId: "replica-b",
  })

  const repeatedSyncEffect = syncSyncedNoteEntries(allEntriesB, remoteB)
  const repeatedSync = yield* runA(repeatedSyncEffect)

  expect(repeatedSync.duplicateEntries).toHaveLength(2)

  yield* runA(rebuildSyncedNoteProjection)

  const rebuilt = yield* runA(readFromA)

  expect(rebuilt).toMatchObject({
    title: "from b",
    revision: 2,
    replicaId: "replica-b",
  })

  const restartedA = pipe(syncedNoteReplicaLayer("replica-a"), Layer.provide(databaseA))
  const restartedContextA = yield* Layer.build(restartedA)
  const persisted = yield* Effect.provide(readFromA, restartedContextA)

  expect(persisted).toMatchObject({
    title: "from b",
    revision: 2,
    replicaId: "replica-b",
  })
}, Effect.scoped, Effect.provide(BunServices.layer)))
