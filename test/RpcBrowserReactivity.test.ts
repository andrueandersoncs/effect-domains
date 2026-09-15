import { expect, it } from "@effect/vitest"
import { Array, Context, Deferred, Effect, Fiber, Function, Layer, Option, Ref, Schema, Stream, pipe } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import { Requests, RequestStateSchema, RequestTokenSchema } from "effect-domains/requests"
import { RpcBrowser } from "effect-domains/rpc-browser"

const NoteSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
})

const NotesSchema = Schema.Array(NoteSchema)
const FieldErrorsSchema = Schema.Record(Schema.String, Schema.String)
const RejectArgumentsSchema = Schema.Struct({ value: Schema.String })


const BrowserRequestModelSchema = Schema.Struct({
  requests: RequestStateSchema,
  notice: Schema.NullOr(Schema.String),
})

const ValidationFailurePayloadSchema = Schema.Struct({
  error: Schema.String,
  fieldErrors: FieldErrorsSchema,
})

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

class ValidationFailed extends Schema.TaggedClass<ValidationFailed>()("ValidationFailed", {
  error: Schema.String,
  fieldErrors: FieldErrorsSchema,
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
  const notes = yield* store.read

  return { notes }
})

const persistNote = Effect.fn("NotesStore.persistNote")(function* ({ note }: SaveArguments) {
  const store = yield* NotesStore
  const saved = yield* store.save(note)

  return { note: saved }
})

const rejectNote = Effect.fn("NotesStore.rejectNote")(function* () {
  return yield* Effect.fail("rejected")
})

const validationFailurePayload = () => ValidationFailurePayloadSchema.make({
  error: "Invalid note.",
  fieldErrors: { value: "Choose another value." },
})

const subscriptions = RpcBrowser.query<Model, typeof MessageSchema.Type>()("notes", {
  dependencies: QueryDependencies.fields,
  modelToDependencies: selectQueryDependencies,
  reactivityKeys: ["notes"],
  execute: selectNotes,
  success: Received,
  failure: QueryFailed,
})

const Save = RpcBrowser.mutation("SaveNote", {
  request: "notes.save",
  args: { note: NoteSchema },
  success: Saved,
  failure: MutationFailed,
  invalidates: ["notes"],
  execute: persistNote,
})

const Reject = RpcBrowser.command("RejectNote", {
  request: "notes.reject",
  args: RejectArgumentsSchema.fields,
  success: Saved,
  failure: ValidationFailed,
  execute: rejectNote,
  failurePayload: validationFailurePayload,
})

const RejectByValue = RpcBrowser.command("RejectNoteByValue", {
  request: {
    key: { prefix: "notes.rejectByValue", fields: ["value"] },
    concurrency: "latest",
  },
  args: RejectArgumentsSchema.fields,
  success: Saved,
  failure: ValidationFailed,
  execute: rejectNote,
  failurePayload: validationFailurePayload,
})

it("browser commands own request start and stale settlement", () => {
  const initial = BrowserRequestModelSchema.make({ requests: Requests.empty(), notice: "ready" })
  const started = Reject.start(initial, { value: "bad" }, { notice: null })
  const command = pipe(started.commands, Array.head, Option.getOrThrow)
  const request = RequestTokenSchema.make(command.args?.request)
  const requestPending = Requests.pending(started.model.requests, "notes.reject")

  expect(requestPending).toBe(true)
  expect(started.model.notice).toBeNull()

  const succeeded = RpcBrowser.succeed(started.model, request, { notice: "done" })
  const stale = RpcBrowser.fail(succeeded.model, request, "late", { notice: "late" })
  const requestSettled = Requests.pending(succeeded.model.requests, "notes.reject")

  expect(requestSettled).toBe(false)
  expect(succeeded.model.notice).toBe("done")
  expect(stale.model).toEqual(succeeded.model)
})

it("field-derived request keys keep concurrent inputs independent", () => {
  const initial = BrowserRequestModelSchema.make({ requests: Requests.empty(), notice: null })
  const firstInput = RejectArgumentsSchema.make({ value: "first" })
  const secondInput = RejectArgumentsSchema.make({ value: "second" })
  const first = RejectByValue.start(initial, firstInput)
  const second = RejectByValue.start(first.model, secondInput)
  const firstKey = RejectByValue.key(firstInput)
  const secondKey = RejectByValue.key(secondInput)
  const firstPending = RejectByValue.pendingFor(second.model, firstInput)
  const secondPending = RejectByValue.pendingFor(second.model, secondInput)

  expect(firstKey).toBe("notes.rejectByValue.first")
  expect(secondKey).toBe("notes.rejectByValue.second")
  expect(firstPending).toBe(true)
  expect(secondPending).toBe(true)
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
  const note = NoteSchema.make({ id: "note-1", title: "Declarative sync" })
  const command = Save.command({ note, request })

  const saved = yield* pipe(
    command.effect as Effect.Effect<typeof Saved.Type, never, NotesStore | Reactivity.Reactivity>,
    Effect.provide(context),
  )

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

it.effect(
  "browser commands derive failure messages and inject request tokens",
  Effect.fn("RpcBrowser.failurePayload")(function* () {
    const request = RequestTokenSchema.make({ epoch: 1, id: 2, key: "notes.reject" })
    const command = Reject.command({ value: "bad", request })
    const rejected = yield* command.effect

    const expected = ValidationFailed.make({
      request,
      error: "Invalid note.",
      fieldErrors: { value: "Choose another value." },
    })

    expect(rejected).toEqual(expected)
  }),
)
