import { Array, Effect, Equal, Function, Number, Option, Record, Ref, Schema, Struct, flow, pipe } from "effect"
import { FaultDeclaration, ProxyCall, Reply, answer, delayedCalls, disabledSubmitScript, fixtureFact, racingSubmitScript, realCall, replyOf, rewrite, scripted, transparent, type Fault, type FaultBehavior, type FaultContext, type Forward, type ProxyResponse } from "@effect-domains/acceptance/faults"
import { AcceptanceError, PayloadSchema, type Payload } from "@effect-domains/acceptance/model"
import { ReadingListApplication } from "../application.ts"
import { ReadingListBookSchema } from "../domain.ts"

const isPayload = Schema.is(PayloadSchema)

// The defaults come from the compiled application, not the evaluator, because a fault must not share the verifier's derivation.
const nativeCreationDefaults = pipe(
  ReadingListApplication.resources,
  Array.findFirst(flow(Struct.get("name"), Equal.equals("books"))),
  Option.map(flow(Struct.get("creation"), Struct.get("defaults"))),
  Option.filter(isPayload),
)

const missingDefaults = AcceptanceError.make({ boundary: "fault", message: "The compiled books creation defaults are unavailable" })

const withinSuccess = Number.between({ minimum: 200, maximum: 299 })

const withinClientError = Number.between({ minimum: 400, maximum: 499 })

const callsTo = (operation: string) => (request: ProxyCall): boolean => Equal.equals(request.operation, operation)

const createCall = callsTo("books.create")

const updateCall = callsTo("books.update")

const listCall = callsTo("books.list")

const decided = (call: FaultBehavior["call"], document: FaultBehavior["document"]): FaultBehavior => ({ call, document })

const uuidv7 = Effect.sync(() => Bun.randomUUIDv7())

const noError = Option.none<unknown>()

// The create is answered here because a success-without-write defect must look native while storing nothing.
const fabricateCreate = (context: FaultContext) => Effect.fn("ReadingListFaults.fabricateCreate")(function* (request: ProxyCall, forward: Forward) {
  if (!createCall(request)) return yield* forward(request)

  const defaults = yield* pipe(nativeCreationDefaults, Effect.fromOption, Effect.mapError(Function.constant(missingDefaults)))
  const id = yield* uuidv7
  const row = PayloadSchema.make({ ...defaults, ...request.input, id })
  const result = Option.some(row)
  const reply = Reply.make({ result, error: noError })

  yield* context.record(`answered books.create with fabricated id ${id} without forwarding`)

  return yield* answer(200, reply)
})

class StaleState extends Schema.Class<StaleState>("StaleState")({
  updated: Schema.Boolean,
  stale: Schema.Boolean,
}) {}

const fresh = StaleState.make({ updated: false, stale: false })

const markUpdated = (state: StaleState) => StaleState.make({ updated: true, stale: state.stale })

const markStale = (state: StaleState) => StaleState.make({ updated: state.updated, stale: state.updated })

const ItemsSchema = Schema.Array(PayloadSchema)

const decodeItems = Schema.decodeUnknownOption(ItemsSchema)

const sameBook = (id: string) => (row: Payload): boolean => Equal.equals(row.id, id)

const restoreTarget = (id: string, target: Payload) => (row: Payload) => sameBook(id)(row) ? PayloadSchema.make({ ...row, ...target }) : row

const staleListing = Effect.fn("ReadingListFaults.staleListing")(function* (context: FaultContext, response: ProxyResponse) {
  const reply = yield* replyOf(response)
  const page = Option.filter(reply.result, isPayload)
  const items = pipe(page, Option.flatMap(Record.get("items")), Option.flatMap(decodeItems))
  const listing = Option.all({ page, items })

  if (Option.isNone(listing)) return response

  const target = yield* fixtureFact(context, "target", PayloadSchema)
  const id = yield* fixtureFact(context, "target.id", Schema.String)
  const restored = Array.map(listing.value.items, restoreTarget(id, target))
  const stale = Record.set(listing.value.page, "items", restored)
  const result = Option.some(stale)
  const rewritten = Reply.make({ result, error: reply.error })

  yield* context.record(`rewrote books.list so target ${id} shows its pre-update values`)

  return yield* rewrite(response, rewritten)
})

// The list is rewritten only after a later document load because a stale-cache defect hides the update only on reload.
const staleAfterReload = (context: FaultContext, state: Ref.Ref<StaleState>) => Effect.fn("ReadingListFaults.staleAfterReload")(function* (request: ProxyCall, forward: Forward) {
  const response = yield* forward(request)
  const current = yield* Ref.get(state)
  const accepted = withinSuccess(response.status)
  const updating = updateCall(request) && accepted
  const listing = listCall(request) && current.stale

  if (updating) yield* Ref.update(state, markUpdated)

  if (updating) yield* context.record("forwarded the accepted books.update")

  return listing ? yield* staleListing(context, response) : response
})

const staleDocument = Effect.fn("ReadingListFaults.staleDocument")(function* (context: FaultContext, state: Ref.Ref<StaleState>) {
  const current = yield* Ref.updateAndGet(state, markStale)

  if (current.stale) yield* context.record("document loaded after the update; the stale cache now serves the target")

  return Option.none<string>()
})

const updateLostAfterReload = Effect.fn("ReadingListFaults.updateLostAfterReload")(function* (context: FaultContext) {
  const state = yield* Ref.make(fresh)
  const call = staleAfterReload(context, state)
  const document = staleDocument(context, state)

  return decided(call, document)
})

// The id is rewritten because a wrong-target defect applies the submitted update to the unrelated sentinel.
const retarget = (context: FaultContext) => Effect.fn("ReadingListFaults.retarget")(function* (request: ProxyCall, forward: Forward) {
  if (!updateCall(request)) return yield* forward(request)

  const sentinel = yield* fixtureFact(context, "sentinel.id", Schema.String)
  const input = PayloadSchema.make({ ...request.input, id: sentinel })
  const rewritten = ProxyCall.make({ operation: request.operation, input })

  yield* context.record(`forwarded books.update with id rewritten to sentinel ${sentinel}`)

  return yield* forward(rewritten)
})

const RatingSchema = Schema.NullOr(Schema.Int)

const differentRating = (rating: number | null) => Equal.equals(rating, 5) ? 1 : 5

// The real rejection is kept because a rejected-but-mutating defect must look refused while still writing.
const mutateOnRejection = (context: FaultContext) => Effect.fn("ReadingListFaults.mutateOnRejection")(function* (request: ProxyCall, forward: Forward) {
  const response = yield* forward(request)
  const rejected = withinClientError(response.status)
  const mutating = updateCall(request) && rejected

  if (!mutating) return response

  const current = yield* fixtureFact(context, "target.rating", RatingSchema)
  const rating = differentRating(current)
  const input = PayloadSchema.make({ ...request.input, rating })

  yield* realCall(context, "books.update", input)

  return response
})

const domainFields = Record.keys(ReadingListBookSchema.fields)

const bookFields = Array.append(domainFields, "id")

const isBookField = (_value: unknown, key: string) => Array.contains(bookFields, key)

const mutatedNotes = "Sentinel notes rewritten by a defective create"

// The sentinel is rewritten after the real create because an unrelated-mutation defect stores both.
const mutateUnrelated = (context: FaultContext) => Effect.fn("ReadingListFaults.mutateUnrelated")(function* (request: ProxyCall, forward: Forward) {
  const response = yield* forward(request)
  const accepted = withinSuccess(response.status)
  const mutating = createCall(request) && accepted

  if (!mutating) return response

  const sentinel = yield* fixtureFact(context, "sentinel", PayloadSchema)
  const book = Record.filter(sentinel, isBookField)
  const input = PayloadSchema.make({ ...book, notes: mutatedNotes })

  yield* realCall(context, "books.update", input)

  return response
})

const callsOnly = (decide: (context: FaultContext) => FaultBehavior["call"]) => Effect.fn("ReadingListFaults.callsOnly")(function* (context: FaultContext) {
  const call = decide(context)
  const behavior = decided(call, Effect.succeedNone)

  return yield* Effect.succeed(behavior)
})

const forwarding = Effect.fn("ReadingListFaults.forwarding")(function* () {
  return yield* Effect.succeed(transparent)
})

const noOverride = Option.none<number>()

const createWithoutWrite: Fault = {
  declaration: FaultDeclaration.make({
    id: "create-without-write",
    label: "Defective implementation: create without write",
    description: "books.create answers 200 with a native-shaped row (submitted input, a fresh UUIDv7 id, compiled defaults) but nothing is stored.",
    kind: "defective-implementation",
    scenario: "create-sample",
    affected: ["RL-CREATE", "RL-RELOAD"],
    deadlineSeconds: noOverride,
    maxActions: noOverride,
  }),
  behavior: callsOnly(fabricateCreate),
}

const updateLost: Fault = {
  declaration: FaultDeclaration.make({
    id: "update-lost-after-reload",
    label: "Defective implementation: update lost after reload",
    description: "books.update is stored, but after the next page document load books.list keeps serving the target's pre-update values from a stale cache.",
    kind: "defective-implementation",
    scenario: "rating-minimum",
    affected: ["RL-RATING", "RL-RELOAD"],
    deadlineSeconds: noOverride,
    maxActions: noOverride,
  }),
  behavior: updateLostAfterReload,
}

const updateWrongTarget: Fault = {
  declaration: FaultDeclaration.make({
    id: "update-wrong-target",
    label: "Defective implementation: update applied to the wrong book",
    description: "books.update is forwarded with its id rewritten to the unrelated sentinel book.",
    kind: "defective-implementation",
    scenario: "rating-maximum",
    affected: ["RL-RATING", "RL-RELOAD", "RL-PRESERVE"],
    deadlineSeconds: noOverride,
    maxActions: noOverride,
  }),
  behavior: callsOnly(retarget),
}

const rejectedButMutating: Fault = {
  declaration: FaultDeclaration.make({
    id: "rejected-but-mutating",
    label: "Defective implementation: rejected update still mutates",
    description: "The invalid books.update keeps its real 400 rejection, but a valid rating update of the target is also stored.",
    kind: "defective-implementation",
    scenario: "rating-above",
    affected: ["RL-REJECT"],
    deadlineSeconds: noOverride,
    maxActions: noOverride,
  }),
  behavior: callsOnly(mutateOnRejection),
}

const createMutatesUnrelated: Fault = {
  declaration: FaultDeclaration.make({
    id: "create-mutates-unrelated",
    label: "Defective implementation: create mutates an unrelated book",
    description: "books.create is stored and the unrelated sentinel's notes are also rewritten.",
    kind: "defective-implementation",
    scenario: "create-null",
    affected: ["RL-PRESERVE"],
    deadlineSeconds: noOverride,
    maxActions: noOverride,
  }),
  behavior: callsOnly(mutateUnrelated),
}

const deadline: Fault = {
  declaration: FaultDeclaration.make({
    id: "deadline",
    label: "Execution control: deadline",
    description: "Every public call is delayed by 5 seconds while the scenario deadline is 4 seconds, so the run must stop at its deadline without passing any criterion.",
    kind: "execution-control",
    scenario: "create-sample",
    affected: [],
    deadlineSeconds: Option.some(4),
    maxActions: noOverride,
  }),
  behavior: delayedCalls("5 seconds"),
}

const actionLimit: Fault = {
  declaration: FaultDeclaration.make({
    id: "action-limit",
    label: "Execution control: action limit",
    description: "The no-progress budget is two actions, fewer than opening, filling, and submitting the form, so the run must stop at its action limit without passing any criterion.",
    kind: "execution-control",
    scenario: "create-sample",
    affected: [],
    deadlineSeconds: noOverride,
    maxActions: Option.some(2),
  }),
  behavior: forwarding,
}

const racingTarget: Fault = {
  declaration: FaultDeclaration.make({
    id: "racing-target",
    label: "Execution control: racing target",
    description: "An injected script mutates the active form's submit button attributes every 250 ms, so offered browser snapshots go stale before they can be executed.",
    kind: "execution-control",
    scenario: "rating-minimum",
    affected: [],
    deadlineSeconds: noOverride,
    maxActions: noOverride,
  }),
  behavior: scripted("racing-submit", racingSubmitScript),
}

const disabledSubmit: Fault = {
  declaration: FaultDeclaration.make({
    id: "disabled-submit",
    label: "Execution control: disabled submit",
    description: "An injected script keeps the generated submit button disabled, so the create can never be submitted.",
    kind: "execution-control",
    scenario: "create-null",
    affected: [],
    deadlineSeconds: noOverride,
    maxActions: noOverride,
  }),
  behavior: scripted("disabled-submit", disabledSubmitScript),
}

/** Reading List's labeled defective implementations and execution controls, each injected only into its isolated owned application. */
export const readingListFaults: ReadonlyArray<Fault> = [createWithoutWrite, updateLost, updateWrongTarget, rejectedButMutating, createMutatesUnrelated, deadline, actionLimit, racingTarget, disabledSubmit]
