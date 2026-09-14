import { expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Fiber, Function, Layer, Ref, Schema, Stream, pipe } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import { RequestTokenSchema } from "effect-domains/requests"
import { RpcBrowser } from "effect-domains/rpc-browser"

const NoteSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
})

const NotesSchema = Schema.Array(NoteSchema)

class NotesStore extends Context.Service<NotesStore, {
  readonly read: Effect.Effect<ReadonlyArray<typeof NoteSchema.Type>>
  readonly save: (note: typeof NoteSchema.Type) => Effect.Effect<typeof NoteSchema.Type>
}>()("test/NotesStore") {}

const ModelSchema = Schema.Struct({ refresh: Schema.Int })
type Model = typeof ModelSchema.Type

class QueryDependencies extends Schema.Class<QueryDependencies>("QueryDependencies")({
  refresh: Schema.Int,
}) {}

class Received extends Schema.TaggedClass<Received>()("Received", {
  notes: NotesSchema,
}) {}

class Saved extends Schema.TaggedClass<Saved>()("Saved", {
  note: NoteSchema,
  request: RequestTokenSchema,
}) {}

class QueryFailed extends Schema.TaggedClass<QueryFailed>()("QueryFailed", {
  error: Schema.String,
}) {}

class MutationFailed extends Schema.TaggedClass<MutationFailed>()("MutationFailed", {
  error: Schema.String,
  request: RequestTokenSchema,
}) {}

class SaveArguments extends Schema.Class<SaveArguments>("SaveArguments")({
  note: NoteSchema,
  request: RequestTokenSchema,
}) {}

const MessageSchema = Schema.Union([Received, Saved, QueryFailed, MutationFailed])

const selectQueryDependencies = (model: Model) =>
  QueryDependencies.make({ refresh: model.refresh })

const selectNotes = Effect.fn("NotesStore.selectNotes")(function* (_dependencies: QueryDependencies) {
  const store = yield* NotesStore

  return yield* store.read
})

const receiveNotes = (notes: ReadonlyArray<typeof NoteSchema.Type>) =>
  Received.make({ notes })

const failQuery = (error: unknown) => {
  const message = String(error)

  return QueryFailed.make({ error: message })
}

const persistNote = Effect.fn("NotesStore.persistNote")(function* ({ note }: SaveArguments) {
  const store = yield* NotesStore

  return yield* store.save(note)
})

const succeedMutation = (note: typeof NoteSchema.Type, { request }: SaveArguments) =>
  Saved.make({ note, request })

const failMutation = (error: unknown, { request }: SaveArguments) => {
  const message = String(error)

  return MutationFailed.make({ error: message, request })
}

const subscriptions = RpcBrowser.query<Model, typeof MessageSchema.Type>()("notes", {
  dependencies: QueryDependencies.fields,
  modelToDependencies: selectQueryDependencies,
  reactivityKeys: ["notes"],
  execute: selectNotes,
  onSuccess: receiveNotes,
  onFailure: failQuery,
})

const Save = RpcBrowser.mutation("SaveNote", {
  args: { note: NoteSchema },
  success: Saved,
  failure: MutationFailed,
  invalidates: ["notes"],
  execute: persistNote,
  onSuccess: succeedMutation,
  onFailure: failMutation,
})

it.effect("a reactive RPC mutation automatically refetches its mounted Foldkit query", Effect.fn("RpcBrowser.reactivity")(function* () {
  const state = yield* Ref.make<ReadonlyArray<typeof NoteSchema.Type>>([])
  const reads = yield* Ref.make(0)
  const firstRead = yield* Deferred.make<void>()

  const read = Effect.gen(function* () {
    yield* Ref.update(reads, (count) => count + 1)
    const notes = yield* Ref.get(state)
    yield* Deferred.succeed(firstRead, undefined)

    return notes
  })

  const save = Effect.fn("NotesStore.save")(function* (note: typeof NoteSchema.Type) {
    yield* Ref.update(state, (notes) => [...notes, note])

    return note
  })

  const store = NotesStore.of({ read, save })
  const storeLayer = Layer.succeed(NotesStore, store)
  const services = Layer.mergeAll(storeLayer, Reactivity.layer)
  const context = yield* Layer.build(services)
  const dependencies = subscriptions.notes.modelToDependencies({ refresh: 0 })
  const readDependencies = Function.constant(dependencies)

  const messagesEffect = pipe(
    subscriptions.notes.dependenciesToStream(dependencies, readDependencies),
    Stream.take(2),
    Stream.runCollect,
    Effect.provide(context),
  )

  const messagesFiber = yield* Effect.forkScoped(messagesEffect)

  yield* Deferred.await(firstRead)

  const request = RequestTokenSchema.make({ epoch: 0, id: 1, key: "notes.save" })
  const command = Save({ note: { id: "note-1", title: "Declarative sync" }, request })
  const saved = yield* Effect.provide(command.effect, context)
  const messages = yield* Fiber.join(messagesFiber)
  const readCount = yield* Ref.get(reads)

  const expectedSaved = Saved.make({
    note: { id: "note-1", title: "Declarative sync" },
    request,
  })

  const expectedMessages = [
    Received.make({ notes: [] }),
    Received.make({ notes: [{ id: "note-1", title: "Declarative sync" }] }),
  ]

  expect(saved).toEqual(expectedSaved)
  expect(messages).toEqual(expectedMessages)
  expect(readCount).toBe(2)
}))
