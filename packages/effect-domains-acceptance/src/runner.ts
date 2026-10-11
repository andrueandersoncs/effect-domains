import { Array, Config, DateTime, Duration, Effect, Equal, Equivalence, Function, type Layer, Number, Option, Order, Predicate, Record, Redacted, Ref, Result, Schema, Struct, flow, pipe } from "effect"
import type { ApplicationIR } from "effect-domains/application"
import { join } from "node:path"
import { BrowserTarget, browserLayer } from "./browser.ts"
import { CatalogBindings, byId, nativeOperations, validateCatalog } from "./catalog.ts"
import { JevConfiguration, jevLayer } from "./decision.ts"
import type { Secret } from "./server.ts"

import {
  AcceptanceError,
  Action,
  Actor,
  BrowserSurface,
  BuildIdentity,
  Candidate,
  Catalog,
  Decision,
  DecisionModel,
  DecisionState,
  DeniedSchema,
  EvaluationContext,
  FixtureRuntime,
  InputCandidates,
  type InputCase,
  Observation,
  Offer,
  type Payload,
  PayloadSchema,
  PreparedFixture,
  ProbeRecord,
  ProbeTarget,
  RejectedSchema,
  type Requirement,
  RequirementEvaluation,
  RequirementResult,
  RunEvidence,
  Scenario,
  ScenarioRun,
  Submission,
  TraceEntry,
} from "./model.ts"

const OptionalPathSchema = Schema.OptionFromOptionalKey(Schema.String)

/** `replay` names a recorded run.json to re-execute without a model. */
export class RunConfiguration extends Schema.Class<RunConfiguration>("RunConfiguration")({
  output: Schema.String,
  seed: Schema.Int,
  model: Schema.String,
  minimumConfidence: Schema.Number,
  maxActions: Schema.Int,
  deadlineSeconds: Schema.Int,
  replay: OptionalPathSchema,
}) {}

export interface AcceptanceDefinition {
  readonly name: string
  readonly title: string
  readonly catalog: typeof Catalog.Encoded
  readonly application: ApplicationIR
  /** The evaluator names the application's RequirementEvaluation implements because every requirement must name one of them. */
  readonly evaluators: ReadonlyArray<string>
  /** Maps an observed resource to the native list operation the browser captures it through. */
  readonly observationOperation: (resource: string) => string
  /** Probes taken after each accepted submission because hidden state must be read at every step, not only at the end. */
  readonly submissionProbes: ReadonlyArray<string>
  /** Operations re-called directly after the run because enforcement must be proven server-side, not only through the UI. */
  readonly directProbes: ReadonlyArray<string>
  readonly defaultMaxActions: number
}

class ReplayTraceEntry extends Schema.Class<ReplayTraceEntry>("ReplayTraceEntry")({
  action: Action,
  executed: Schema.Boolean,
}) {}

const ReplayTraceSchema = Schema.Array(ReplayTraceEntry)
const RecordedCandidatesSchema = Schema.Array(Candidate)

class ReplayScenario extends Schema.Class<ReplayScenario>("ReplayScenario")({
  scenario: Scenario,
  candidates: RecordedCandidatesSchema,
  trace: ReplayTraceSchema,
}) {}

class ReplayBuild extends Schema.Class<ReplayBuild>("ReplayBuild")({
  sourceHash: Schema.String,
  bundleHash: Schema.String,
  catalogHash: Schema.String,
  nativeContractsHash: Schema.String,
}) {}

const ReplayScenariosSchema = Schema.Array(ReplayScenario)

/** The part of a recorded run.json a replay needs: which application and build recorded it and every scenario's candidates and actions. */
class Replay extends Schema.Class<Replay>("Replay")({
  application: Schema.NonEmptyString,
  build: ReplayBuild,
  scenarios: ReplayScenariosSchema,
}) {}

const RunModeSchema = Schema.Literals(["exploration", "replay"])

class RetainedConfiguration extends Schema.Class<RetainedConfiguration>("RetainedConfiguration")({
  model: Schema.String,
  minimumConfidence: Schema.Number,
  maxActions: Schema.Int,
  deadlineSeconds: Schema.Int,
  seed: Schema.Int,
  mode: RunModeSchema,
  replay: OptionalPathSchema,
}) {}

const ScenarioRunsSchema = Schema.Array(ScenarioRun)
const LeaksSchema = Schema.Array(Schema.String)
const OptionalFinishedSchema = Schema.OptionFromOptionalKey(Schema.String)
const RunStatusSchema = Schema.Literals(["pass", "not-passed"])
const OptionalRunStatusSchema = Schema.OptionFromOptionalKey(RunStatusSchema)

class RunReport extends Schema.Class<RunReport>("RunReport")({
  application: Schema.NonEmptyString,
  startedAt: Schema.String,
  catalog: Catalog,
  build: BuildIdentity,
  configuration: RetainedConfiguration,
  scenarios: ScenarioRunsSchema,
  evidenceLeaks: LeaksSchema,
  finishedAt: OptionalFinishedSchema,
  status: OptionalRunStatusSchema,
}) {}

const OptionalFailureSchema = Schema.OptionFromOptionalKey(Schema.String)

class CompletedSubmission extends Schema.Class<CompletedSubmission>("CompletedSubmission")({
  inputCase: Schema.String,
  operation: Schema.String,
  status: Schema.Int,
  failure: OptionalFailureSchema,
}) {}

class RemainingInput extends Schema.Class<RemainingInput>("RemainingInput")({
  id: Schema.String,
  description: Schema.String,
  expectedResponse: Schema.String,
}) {}

const ViewRowsSchema = Schema.Array(PayloadSchema)

class CurrentView extends Schema.Class<CurrentView>("CurrentView")({
  operation: Schema.String,
  resource: Schema.String,
  loaded: Schema.Boolean,
  rows: ViewRowsSchema,
}) {}

const CompletedSubmissionsSchema = Schema.Array(CompletedSubmission)
const RemainingInputsSchema = Schema.Array(RemainingInput)
const ActiveFormSchema = Schema.OptionFromOptionalKey(Schema.String)

class DecisionView extends Schema.Class<DecisionView>("DecisionView")({
  actor: Schema.String,
  completed: CompletedSubmissionsSchema,
  remaining: RemainingInputsSchema,
  reloadRequired: Schema.Boolean,
  reloadComplete: Schema.Boolean,
  view: CurrentView,
  activeForm: ActiveFormSchema,
}) {}

const SubmissionsSchema = Schema.Array(Submission)
const CandidatesSchema = Schema.Array(Candidate)
const ProbeRecordsSchema = Schema.Array(ProbeRecord)
const ObservationsSchema = Schema.Array(Observation)
const NamesSchema = Schema.Array(Schema.String)
const TraceEntriesSchema = Schema.Array(TraceEntry)
const RepeatedSchema = Schema.Record(Schema.String, Schema.Int)

class Progress extends Schema.Class<Progress>("Progress")({
  view: Observation,
  submissions: SubmissionsSchema,
  candidates: CandidatesSchema,
  probes: ProbeRecordsSchema,
  reloaded: Schema.Boolean,
  activeForm: ActiveFormSchema,
  trace: TraceEntriesSchema,
  repeated: RepeatedSchema,
}) {}

class Baseline extends Schema.Class<Baseline>("Baseline")({
  before: ObservationsSchema,
  probes: ProbeRecordsSchema,
  start: Observation,
}) {}

class Closing extends Schema.Class<Closing>("Closing")({
  after: ObservationsSchema,
  probes: ProbeRecordsSchema,
  directProbes: SubmissionsSchema,
}) {}

const OptionalReplayScenarioSchema = Schema.OptionFromOptionalKey(ReplayScenario)

class ScenarioInput extends Schema.Class<ScenarioInput>("ScenarioInput")({
  catalog: Catalog,
  scenario: Scenario,
  actor: Actor,
  fixture: PreparedFixture,
  artifacts: Schema.String,
  configuration: RunConfiguration,
  seed: Schema.Int,
  replay: OptionalReplayScenarioSchema,
  observations: NamesSchema,
  submissionProbes: NamesSchema,
  directProbes: NamesSchema,
}) {}

const IdentifiedSchema = Schema.Struct({ id: Schema.String })

interface Identified extends Schema.Schema.Type<typeof IdentifiedSchema> {}

class TaggedFailure extends Schema.Class<TaggedFailure>("TaggedFailure")({
  _tag: Schema.String,
}) {}

const emptyKey = Redacted.make("")

const viewRowLimit = 20

const runnerFailure = (boundary: string) => (message: string) => AcceptanceError.make({ boundary, message })

const recordingExhausted = runnerFailure("replay")("Recorded actions exhausted before obligations were exercised")

const noAvailableAction = runnerFailure("decision")("Decision selected no available action")

const cannotProceed = runnerFailure("decision")("Decision chose cannot-proceed")

const missingSubject = runnerFailure("scope")("Accepted submission has neither a captured id nor a prepared target")

const describeDecisionFailure = flow(String, runnerFailure("decision"))

const now = Effect.map(DateTime.now, DateTime.formatIso)

const fingerprintOf = (action: Action) => {
  const operation = Option.getOrUndefined(action.operation)
  const inputCase = Option.getOrUndefined(action.inputCase)
  const value = Option.getOrUndefined(action.value)

  return JSON.stringify([action.kind, operation, inputCase, value, action.target])
}

const valueText = flow(Option.getOrUndefined<Payload>, JSON.stringify)

const sameValue = (left: Option.Option<Payload>) => (right: Option.Option<Payload>) => {
  const leftText = valueText(left)
  const rightText = valueText(right)

  return Equivalence.strictEqual<string>()(leftText, rightText)
}

// A filled action carries its payload in the action itself because the replayed fixture issues fresh identities into that payload.
const payloadMatches = (recorded: Action, value: Option.Option<Payload>) => (option: Action) => {
  const filled = Equal.equals(recorded.kind, "fill")
  const same = sameValue(value)(option.value)

  return filled ? same : true
}

const matchesRecorded = (recorded: Action, value: Option.Option<Payload>) => (option: Action) => {
  const sameId = Equal.equals(option.id, recorded.id)
  const sameKind = Equal.equals(option.kind, recorded.kind)
  const sameOperation = Equal.equals(option.operation, recorded.operation)
  const sameInputCase = Equal.equals(option.inputCase, recorded.inputCase)
  const sameTarget = Equal.equals(option.target, recorded.target)
  const same = Array.every([sameId, sameKind, sameOperation, sameInputCase, sameTarget], Boolean)

  return same && payloadMatches(recorded, value)(option)
}

const byCandidateCase = (inputCase: Option.Option<string>) => (candidate: Candidate) => Option.contains(inputCase, candidate.inputCase)

const resolvedValue = (recorded: Action, available: ReadonlyArray<Candidate>) =>
  pipe(available, Array.findFirst(byCandidateCase(recorded.inputCase)), Option.map(Struct.get("input")))

const consumedCases = (progress: Progress) => Array.map(progress.submissions, Struct.get("inputCase"))

const consumedBy = (consumed: ReadonlyArray<string>) => (id: string) => Array.contains(consumed, id)

const unconsumed = (consumed: ReadonlyArray<string>) => (candidate: Candidate) => !consumedBy(consumed)(candidate.inputCase)

const requiredConsumed = (scenario: Scenario, progress: Progress) => {
  const consumed = consumedCases(progress)

  return Array.every(scenario.required, consumedBy(consumed))
}

const isComplete = (scenario: Scenario, progress: Progress) => {
  const consumed = requiredConsumed(scenario, progress)
  const reloadSatisfied = progress.reloaded || Equal.equals(scenario.reload, false)

  return consumed && reloadSatisfied
}

const reloadOffered = (scenario: Scenario, progress: Progress) => {
  const consumed = requiredConsumed(scenario, progress)
  const pending = Equal.equals(progress.reloaded, false)
  const awaiting = consumed && pending

  return awaiting && scenario.reload
}

const isScalar = pipe(Predicate.isString, Predicate.or(Predicate.isNumber), Predicate.or(Predicate.isBoolean), Predicate.or(Predicate.isNull))

const scalarColumns = (row: Payload) => Record.filter(row, isScalar)

const currentView = (observation: Observation) => {
  const rows = pipe(observation.rows, Array.take(viewRowLimit), Array.map(scalarColumns))

  return CurrentView.make({ operation: observation.operation, resource: observation.resource, loaded: observation.loaded, rows })
}

const completedSubmission = (submission: Submission) => {
  const failure = pipe(submission.error, Option.flatMap(Schema.decodeUnknownOption(TaggedFailure)), Option.map(Struct.get("_tag")))

  return CompletedSubmission.make({ inputCase: submission.inputCase, operation: submission.operation, status: submission.status, failure })
}

const findById = <A extends Identified>(entries: ReadonlyArray<A>, kind: string, id: string) => {
  const missing = runnerFailure("catalog")(`Missing ${kind} ${id}`)

  return pipe(entries, Array.findFirst(byId(id)), Effect.fromOption, Effect.mapError(Function.constant(missing)))
}

const isDeniedOutcome = Schema.is(DeniedSchema)
const isRejectedOutcome = Schema.is(RejectedSchema)
const purposefulRefusal = "submitting it is the purpose of this check, so enter and submit it"

const rejectionResponse = `the application rejects it as input outside the native contract; ${purposefulRefusal}`

const expectedResponse = (input: InputCase) => {
  if (isDeniedOutcome(input.outcome)) return `the application refuses it with ${input.outcome.failure}; ${purposefulRefusal}`

  return isRejectedOutcome(input.outcome) ? rejectionResponse : "the application accepts it"
}

const remainingDescription = (input: InputCase) => RemainingInput.make({ id: input.id, description: input.description, expectedResponse: expectedResponse(input) })

const remainingInput = (scenario: Scenario) => (id: string) => {
  const declared = Array.findFirst(scenario.inputs, byId(id))
  const unknown = RemainingInput.make({ id, description: "", expectedResponse: "" })

  return Option.match(declared, { onNone: Function.constant(unknown), onSome: remainingDescription })
}

const decisionView = (input: ScenarioInput, progress: Progress) => {
  const consumed = consumedCases(progress)
  const completed = Array.map(progress.submissions, completedSubmission)
  const remaining = pipe(input.scenario.required, Array.filter(Predicate.not(consumedBy(consumed))), Array.map(remainingInput(input.scenario)))
  const view = currentView(progress.view)

  return DecisionView.make({
    actor: input.actor.description,
    completed,
    remaining,
    reloadRequired: input.scenario.reload,
    reloadComplete: progress.reloaded,
    view,
    activeForm: progress.activeForm,
  })
}

const describe = (entry: TraceEntry) => entry.action.description

const replaceLast = (entry: TraceEntry) => (trace: ReadonlyArray<TraceEntry>) => pipe(trace, Array.dropRight(1), Array.append(entry))

const appendTrace = (entry: TraceEntry) => (progress: Progress) => {
  const trace = Array.append(progress.trace, entry)

  return Progress.make({ ...progress, trace })
}

const replaceTrace = (entry: TraceEntry) => (progress: Progress) => {
  const trace = replaceLast(entry)(progress.trace)

  return Progress.make({ ...progress, trace })
}

const tallyAction = (fingerprint: string) => (progress: Progress) => {
  const previous = pipe(progress.repeated, Record.get(fingerprint), Option.getOrElse(Function.constant(0)))
  const repeated = Record.set(progress.repeated, fingerprint, previous + 1)

  return Progress.make({ ...progress, repeated })
}

const leavingKinds: ReadonlyArray<Action["kind"]> = ["observe", "reload"]

const navigated = (action: Action) => (progress: Progress) => {
  const isReload = Equal.equals(action.kind, "reload")
  const opens = Equal.equals(action.kind, "open")
  const leaves = Array.contains(leavingKinds, action.kind)
  const kept = leaves ? Option.none<string>() : progress.activeForm
  const activeForm = opens ? action.operation : kept
  const reloaded = progress.reloaded || isReload

  return Progress.make({ ...progress, activeForm, reloaded })
}

const observed = (view: Observation, entry: TraceEntry) => (progress: Progress) => {
  const trace = replaceLast(entry)(progress.trace)

  return Progress.make({ ...progress, view, trace })
}

const submitted = (submission: Submission, candidate: Candidate) => (progress: Progress) => {
  const submissions = Array.append(progress.submissions, submission)
  const candidates = Array.append(progress.candidates, candidate)

  return Progress.make({ ...progress, submissions, candidates, reloaded: false, repeated: {} })
}

const probed = (records: ReadonlyArray<ProbeRecord>) => (progress: Progress) => {
  const probes = Array.appendAll(progress.probes, records)

  return Progress.make({ ...progress, probes })
}

const hasAcceptedStatus = (submission: Submission) => Number.between(submission.status, { minimum: 200, maximum: 299 })

const capturedId = (submission: Submission) =>
  pipe(submission.result, Option.flatMap(Schema.decodeUnknownOption(IdentifiedSchema)), Option.map(Struct.get("id")))

const targetCase = (fixture: PreparedFixture) => pipe(fixture.facts, Record.get("target.id"), Option.flatMap(Schema.decodeUnknownOption(Schema.String)))

const capturedCases = (submissions: ReadonlyArray<Submission>) => pipe(submissions, Array.filter(hasAcceptedStatus), Array.map(capturedId), Array.getSomes, Array.dedupe)

const trackedSubjects = (fixture: PreparedFixture) => {
  const target = pipe(fixture, targetCase, Option.toArray)

  return pipe(fixture.tracked, Array.appendAll(target), Array.dedupe)
}

const probeTarget = (probe: string, phase: string) => (subject: string) => ProbeTarget.make({ probe, phase, subject })

const probeFor = (phase: string, subject: string) => (probe: string) => ProbeTarget.make({ probe, phase, subject })

const targetsFor = (phase: string, subjects: ReadonlyArray<string>) => (probe: string) => Array.map(subjects, probeTarget(probe, phase))

const probeTargets = (scenario: Scenario, phase: string, subjects: ReadonlyArray<string>) => Array.flatMap(scenario.probes, targetsFor(phase, subjects))

const probeSubject = (fixture: PreparedFixture) => Effect.fn("Acceptance.probeSubject")(function* (target: ProbeTarget) {
  const runtime = yield* FixtureRuntime

  return yield* runtime.probe(fixture, target)
})

const candidatePool = Effect.fn("Acceptance.candidatePool")(function* (input: ScenarioInput, submissions: ReadonlyArray<Submission>) {
  const inputs = yield* InputCandidates

  return yield* Option.match(input.replay, {
    onNone: () => inputs.resolve(input.scenario, input.fixture, submissions, input.seed),
    onSome: (recording) => inputs.replay(input.scenario, recording.candidates, input.fixture, submissions),
  })
})

const OptionalDecisionSchema = Schema.OptionFromOptionalKey(Decision)

class Chosen extends Schema.Class<Chosen>("Chosen")({
  action: Action,
  decision: OptionalDecisionSchema,
}) {}

/** Replays the recorded action at this step only when the identical action is offered again, because a replay never repairs or skips an obligation. */
const recordedChoice = Effect.fn("Acceptance.recordedChoice")(function* (state: Ref.Ref<Progress>, recording: ReplayScenario, options: ReadonlyArray<Action>, available: ReadonlyArray<Candidate>, step: number) {
  const entry = yield* pipe(recording.trace, Array.get(step), Effect.fromOption, Effect.mapError(Function.constant(recordingExhausted)))
  const value = resolvedValue(entry.action, available)
  const strict = Array.findFirst(options, matchesRecorded(entry.action, value))
  const unavailable = runnerFailure("replay")(`Recorded action ${entry.action.id} is no longer available; no criterion is skipped`)
  const action = yield* pipe(strict, Effect.fromOption, Effect.mapError(Function.constant(unavailable)))

  if (!entry.executed) {
    const at = yield* now
    const progress = yield* Ref.get(state)
    const interrupted = TraceEntry.make({ at, action, executed: false, decision: Option.none(), observation: progress.view })

    yield* Ref.update(state, appendTrace(interrupted))

    return yield* runnerFailure("replay")(`Recorded action ${entry.action.id} was not executed; original interruption is preserved`)
  }

  return Chosen.make({ action, decision: Option.none() })
})

const modelChoice = Effect.fn("Acceptance.modelChoice")(function* (input: ScenarioInput, progress: Progress, options: ReadonlyArray<Action>) {
  const model = yield* DecisionModel
  const view = yield* pipe(decisionView(input, progress), Schema.encodeEffect(DecisionView), Effect.mapError(describeDecisionFailure))
  const history = Array.map(progress.trace, describe)
  const state = DecisionState.make({ goal: input.scenario.goal, view, history })
  const decision = yield* model.choose(state, options)
  const action = yield* pipe(options, Array.findFirst(byId(decision.choice)), Effect.fromOption, Effect.mapError(Function.constant(noAvailableAction)))

  return Chosen.make({ action, decision: Option.some(decision) })
})

const belowConfidence = (minimumConfidence: number) => (decision: Decision) => Order.isLessThan(Order.Number)(decision.confidence, minimumConfidence)

/** Refuses a model decision below the configured confidence because an uncertain choice is never executed; replayed choices carry no decision. */
export const confidenceGate = Effect.fn("Acceptance.confidenceGate")(function* (minimumConfidence: number, decision: Option.Option<Decision>) {
  const low = Option.filter(decision, belowConfidence(minimumConfidence))

  if (Option.isSome(low)) {
    return yield* runnerFailure("decision")(`Confidence ${low.value.confidence} is below configured ${minimumConfidence}; action not executed`)
  }
})

const belongsTo = (submission: Submission) => (candidate: Candidate) => {
  const sameCase = Equal.equals(candidate.inputCase, submission.inputCase)
  const sameOperation = Equal.equals(candidate.operation, submission.operation)

  return sameCase && sameOperation
}

const declaredBy = (scenario: Scenario) => (probe: string) => Array.contains(scenario.probes, probe)

const submissionProbes = Effect.fn("Acceptance.submissionProbes")(function* (input: ScenarioInput, submission: Submission) {
  const probes = Array.filter(input.submissionProbes, declaredBy(input.scenario))
  const declared = Array.isReadonlyArrayNonEmpty(probes)
  const probing = declared && hasAcceptedStatus(submission)

  if (!probing) {
    return Array.empty<ProbeRecord>()
  }

  const prepared = targetCase(input.fixture)
  const fallback = Function.constant(prepared)
  const subject = yield* pipe(capturedId(submission), Option.orElse(fallback), Effect.fromOption, Effect.mapError(Function.constant(missingSubject)))
  const phase = `after:${submission.inputCase}`
  const targets = Array.map(probes, probeFor(phase, subject))

  return yield* Effect.forEach(targets, probeSubject(input.fixture))
})

const recordSubmission = Effect.fn("Acceptance.recordSubmission")(function* (input: ScenarioInput, state: Ref.Ref<Progress>, available: ReadonlyArray<Candidate>, outcome: Option.Option<Submission>) {
  if (Option.isNone(outcome)) {
    return
  }

  const outOfScope = runnerFailure("scope")(`Submission ${outcome.value.inputCase} (${outcome.value.operation}) does not belong to an unconsumed declared input case`)
  const candidate = yield* pipe(available, Array.findFirst(belongsTo(outcome.value)), Effect.fromOption, Effect.mapError(Function.constant(outOfScope)))

  yield* Ref.update(state, submitted(outcome.value, candidate))

  const records = yield* submissionProbes(input, outcome.value)

  yield* Ref.update(state, probed(records))
})

const interact: (input: ScenarioInput, state: Ref.Ref<Progress>, step: number) => Effect.Effect<void, AcceptanceError, BrowserSurface | DecisionModel | InputCandidates | FixtureRuntime> = Effect.fn("Acceptance.interact")(function* (input: ScenarioInput, state: Ref.Ref<Progress>, step: number) {
  const exhausted = Order.isGreaterThanOrEqualTo(Order.Number)(step, input.configuration.maxActions)

  if (exhausted) {
    return yield* runnerFailure("deadline")(`Action limit ${input.configuration.maxActions} exhausted`)
  }

  const surface = yield* BrowserSurface
  const progress = yield* Ref.get(state)
  const pool = yield* candidatePool(input, progress.submissions)
  const consumed = consumedCases(progress)
  const available = Array.filter(pool, unconsumed(consumed))
  const reload = reloadOffered(input.scenario, progress)
  const offer = Offer.make({ operations: input.scenario.operations, observations: input.observations, candidates: available, reload })
  const options = yield* surface.actions(offer)
  const chosen = Option.isSome(input.replay) ? yield* recordedChoice(state, input.replay.value, options, available, step) : yield* modelChoice(input, progress, options)
  const at = yield* now
  const pending = TraceEntry.make({ at, action: chosen.action, executed: false, decision: chosen.decision, observation: progress.view })

  yield* Ref.update(state, appendTrace(pending))
  yield* confidenceGate(input.configuration.minimumConfidence, chosen.decision)

  if (Equal.equals(chosen.action.kind, "cannot-proceed")) {
    return yield* cannotProceed
  }

  const fingerprint = fingerprintOf(chosen.action)
  const counted = yield* Ref.updateAndGet(state, tallyAction(fingerprint))
  const count = pipe(counted.repeated, Record.get(fingerprint), Option.getOrElse(Function.constant(0)))

  if (Order.isGreaterThan(Order.Number)(count, 2)) {
    return yield* runnerFailure("progress")(`Repeated action without completion: ${chosen.action.id}`)
  }

  const outcome = yield* surface.execute(chosen.action)
  const executing = TraceEntry.make({ at, action: chosen.action, executed: true, decision: chosen.decision, observation: progress.view })

  yield* Ref.update(state, replaceTrace(executing))
  yield* recordSubmission(input, state, available, outcome)

  const moved = yield* Ref.updateAndGet(state, navigated(chosen.action))
  const screenshot = join(input.artifacts, `step-${step + 1}.png`)
  const view = yield* surface.observe(moved.reloaded, screenshot)
  const executed = TraceEntry.make({ at, action: chosen.action, executed: true, decision: chosen.decision, observation: view })
  const latest = yield* Ref.updateAndGet(state, observed(view, executed))

  if (isComplete(input.scenario, latest)) {
    return
  }

  return yield* interact(input, state, step + 1)
})

const captureList = (artifacts: string, phase: string, reloaded: boolean) => Effect.fn("Acceptance.captureList")(function* (observation: readonly [string, string]) {
  const [resource, operation] = observation
  const surface = yield* BrowserSurface
  const screenshot = join(artifacts, `${phase}-${resource}.png`)

  return yield* surface.capture(operation, reloaded, screenshot)
})

const observedLists = (input: ScenarioInput) => Array.zip(input.scenario.observations, input.observations)

const prerequisites = Effect.fn("Acceptance.prerequisites")(function* (input: ScenarioInput) {
  const surface = yield* BrowserSurface
  const runtime = yield* FixtureRuntime
  const token = yield* runtime.session(input.fixture)

  if (Option.isSome(token)) {
    yield* surface.authenticate(token.value)
  }

  const lists = observedLists(input)
  const before = yield* Effect.forEach(lists, captureList(input.artifacts, "before", false))
  const tracked = trackedSubjects(input.fixture)
  const targets = probeTargets(input.scenario, "before", tracked)
  const probes = yield* Effect.forEach(targets, probeSubject(input.fixture))
  const startPath = join(input.artifacts, "start.png")
  const last = Array.last(before)

  const start = yield* Option.match(last, {
    onNone: () => surface.observe(false, startPath),
    onSome: Effect.succeed,
  })

  return Baseline.make({ before, probes, start })
})

const directlyProbed = (scenario: Scenario, operations: ReadonlyArray<string>) => (inputCase: InputCase) => {
  const required = Array.contains(scenario.required, inputCase.id)
  const direct = Array.contains(operations, inputCase.operation)

  return required && direct
}

const directCandidate = (candidates: ReadonlyArray<Candidate>) => (inputCase: InputCase) => {
  const unresolved = runnerFailure("scope")(`No resolved candidate for direct enforcement probe ${inputCase.id}`)
  const declared = Option.some(inputCase.id)

  return pipe(candidates, Array.findFirst(byCandidateCase(declared)), Effect.fromOption, Effect.mapError(Function.constant(unresolved)))
}

const directProbe = (fixture: PreparedFixture) => Effect.fn("Acceptance.directProbe")(function* (candidate: Candidate) {
  const runtime = yield* FixtureRuntime

  return yield* runtime.direct(fixture, candidate)
})

/** Re-calls every required input of a direct-probe operation against the server because enforcement must hold without the UI. */
const directEnforcement = Effect.fn("Acceptance.directEnforcement")(function* (input: ScenarioInput, progress: Progress) {
  const audited = Array.filter(input.scenario.inputs, directlyProbed(input.scenario, input.directProbes))

  if (Array.isReadonlyArrayEmpty(audited)) {
    return Array.empty<Submission>()
  }

  const pool = yield* candidatePool(input, progress.submissions)
  const candidates = Array.appendAll(progress.candidates, pool)
  const chosen = yield* Effect.forEach(audited, directCandidate(candidates))

  return yield* Effect.forEach(chosen, directProbe(input.fixture))
})

const closingEvidence = Effect.fn("Acceptance.closingEvidence")(function* (input: ScenarioInput, progress: Progress) {
  const lists = observedLists(input)
  const after = yield* Effect.forEach(lists, captureList(input.artifacts, "after", progress.reloaded))
  const captured = capturedCases(progress.submissions)
  const tracked = trackedSubjects(input.fixture)
  const subjects = pipe(tracked, Array.appendAll(captured), Array.dedupe)
  const targets = probeTargets(input.scenario, "after", subjects)
  const probes = yield* Effect.forEach(targets, probeSubject(input.fixture))
  const directProbes = yield* directEnforcement(input, progress)

  return Closing.make({ after, probes, directProbes })
})

const unresolvedResult = (requirement: Requirement, scenario: Scenario, status: "blocked" | "inconclusive", evidence: ReadonlyArray<string>) => (explanation: string) =>
  RequirementResult.make({ requirement: requirement.id, scenario: scenario.id, evaluator: requirement.evaluator, status, explanation, evidence })

const evaluatorExplanation = (error: AcceptanceError) => `Evaluator failed: ${error}`

const inconclusive = (requirement: Requirement, scenario: Scenario, evidence: ReadonlyArray<string>) =>
  flow(evaluatorExplanation, unresolvedResult(requirement, scenario, "inconclusive", evidence), Effect.succeed)

const evaluateRequirement = (catalog: Catalog, context: EvaluationContext) => Effect.fn("Acceptance.evaluateRequirement")(function* (id: string) {
  const evaluation = yield* RequirementEvaluation
  const requirement = yield* findById(catalog.requirements, "requirement", id)

  return yield* pipe(evaluation.evaluate(requirement, context), Effect.catch(inconclusive(requirement, context.scenario, context.evidence)))
})

const unevaluated = (catalog: Catalog, scenario: Scenario, status: "blocked" | "inconclusive", explanation: string, evidence: ReadonlyArray<string>) =>
  Effect.fn("Acceptance.unevaluated")(function* (id: string) {
    const requirement = yield* findById(catalog.requirements, "requirement", id)

    return unresolvedResult(requirement, scenario, status, evidence)(explanation)
  })

const screenshotsOf = (observations: ReadonlyArray<Observation>) => pipe(observations, Array.map(Struct.get("screenshot")), Array.getSomes)

const failureText = (cause: unknown) => `${cause}`

const failureOf = <A, E>(result: Result.Result<A, E>) => pipe(result, Result.getFailure, Option.map(failureText))

const emptyClosing = Closing.make({ after: [], probes: [], directProbes: [] })

const closingOf = (result: Result.Result<Closing, AcceptanceError>) => Result.getOrElse(result, Function.constant(emptyClosing))

const initialProgress = (start: Observation) => Progress.make({
  view: start,
  submissions: [],
  candidates: [],
  probes: [],
  reloaded: false,
  activeForm: Option.none(),
  trace: [],
  repeated: {},
})

const proceed = (input: ScenarioInput) => Effect.fn("Acceptance.proceed")(function* (baseline: Baseline) {
  const initial = initialProgress(baseline.start)
  const state = yield* Ref.make(initial)
  const deadline = Duration.seconds(input.configuration.deadlineSeconds)
  const interaction = yield* pipe(interact(input, state, 0), Effect.timeout(deadline), Effect.result)
  const progress = yield* Ref.get(state)
  const closingResult = yield* pipe(closingEvidence(input, progress), Effect.result)
  const closing = closingOf(closingResult)
  const closingFailure = failureOf(closingResult)
  const interactionFailure = failureOf(interaction)
  const interruptions = Array.getSomes([interactionFailure, closingFailure])
  const joined = Array.join(interruptions, "; ")
  const interruption = Array.isReadonlyArrayNonEmpty(interruptions) ? Option.some(joined) : Option.none<string>()
  const scenarioPath = join(input.artifacts, "scenario.json")
  const traceObservations = Array.map(progress.trace, Struct.get("observation"))
  const beforeShots = screenshotsOf(baseline.before)
  const traceShots = pipe(traceObservations, screenshotsOf, Array.dedupe)
  const afterShots = screenshotsOf(closing.after)
  const shots = pipe(beforeShots, Array.appendAll(traceShots), Array.appendAll(afterShots))
  const evidence = Array.prepend(shots, scenarioPath)
  const probes = pipe(baseline.probes, Array.appendAll(progress.probes), Array.appendAll(closing.probes))

  const context = EvaluationContext.make({
    scenario: input.scenario,
    fixture: input.fixture,
    candidates: progress.candidates,
    submissions: progress.submissions,
    before: baseline.before,
    after: closing.after,
    probes,
    directProbes: closing.directProbes,
    interruption,
    evidence,
  })

  const results = yield* Option.match(closingFailure, {
    onNone: () => Effect.forEach(input.scenario.requirements, evaluateRequirement(input.catalog, context)),
    onSome: (failure) => Effect.forEach(input.scenario.requirements, unevaluated(input.catalog, input.scenario, "inconclusive", `Closing evidence unavailable: ${failure}`, evidence)),
  })

  return ScenarioRun.make({
    scenario: input.scenario,
    fixture: input.fixture,
    candidates: progress.candidates,
    submissions: progress.submissions,
    before: baseline.before,
    after: closing.after,
    probes,
    directProbes: closing.directProbes,
    trace: progress.trace,
    results,
    interruption,
    actionCompletion: isComplete(input.scenario, progress),
  })
})

const blockedRun = (catalog: Catalog, scenario: Scenario, fixture: PreparedFixture, artifacts: string) => Effect.fn("Acceptance.blockedRun")(function* (error: AcceptanceError) {
  const message = String(error)
  const explanation = `Scenario prerequisite failed: ${message}`
  const results = yield* Effect.forEach(scenario.requirements, unevaluated(catalog, scenario, "blocked", explanation, [artifacts]))

  return ScenarioRun.make({
    scenario,
    fixture,
    candidates: [],
    submissions: [],
    before: [],
    after: [],
    probes: [],
    directProbes: [],
    trace: [],
    results,
    interruption: Option.some(message),
    actionCompletion: false,
  })
})

const executeScenario = (input: ScenarioInput) => {
  const baseline = prerequisites(input)

  return Effect.matchEffect(baseline, {
    onFailure: blockedRun(input.catalog, input.scenario, input.fixture, input.artifacts),
    onSuccess: proceed(input),
  })
}

const unpreparedFixture = (scenario: Scenario, actor: Actor) => PreparedFixture.make({ binding: scenario.fixture, url: "", actor: actor.binding, facts: {}, tracked: [] })

const recordedFor = (scenario: Scenario) => (item: ReplayScenario) => Equal.equals(item.scenario.id, scenario.id)

const coveredOnce = (replay: Replay) => (scenario: Scenario) => {
  const recordings = Array.countBy(replay.scenarios, recordedFor(scenario))

  return Equal.equals(recordings, 1)
}

const staleReplay = runnerFailure("replay")("Replay is stale against the application sources, bundle, catalog, or native contracts; record a new exploration")

const uncoveredReplay = runnerFailure("replay")("Replay lacks exact scenario coverage")

const replayFailure = flow(String, runnerFailure("replay"))

/**
 * Decodes a recorded run.json and accepts it only for this application on an identical build, catalog, and native contract with every
 * scenario recorded once, because a stale replay proves nothing.
 */
export const validateReplay = (application: string, build: BuildIdentity, catalog: Catalog) => Effect.fn("Acceptance.validateReplay")(function* (content: unknown) {
  const replay = yield* pipe(content, Schema.decodeUnknownEffect(Replay), Effect.mapError(replayFailure))
  const sameApplication = Equal.equals(replay.application, application)
  const sameSources = Equal.equals(replay.build.sourceHash, build.sourceHash)
  const sameBundle = Equal.equals(replay.build.bundleHash, build.bundleHash)
  const sameCatalog = Equal.equals(replay.build.catalogHash, build.catalogHash)
  const sameContracts = Equal.equals(replay.build.nativeContractsHash, build.nativeContractsHash)
  const fresh = Array.every([sameSources, sameBundle, sameCatalog, sameContracts], Boolean)
  const sameCount = Equal.equals(replay.scenarios.length, catalog.scenarios.length)
  const covered = sameCount && Array.every(catalog.scenarios, coveredOnce(replay))

  if (!sameApplication) return yield* runnerFailure("replay")(`Replay records ${replay.application}, not ${application}`)

  if (!fresh) return yield* staleReplay

  if (!covered) return yield* uncoveredReplay

  return replay
})

const loadReplay = (application: string, build: BuildIdentity, catalog: Catalog) => Effect.fn("Acceptance.loadReplay")(function* (path: string) {
  const evidence = yield* RunEvidence
  const content = yield* evidence.read(path)

  return yield* validateReplay(application, build, catalog)(content)
})

const byRecordedScenario = (scenario: Scenario) => (replay: Replay) => Array.findFirst(replay.scenarios, recordedFor(scenario))

const isPassing = (result: RequirementResult) => Equal.equals(result.status, "pass")

const scenarioPassed = (run: ScenarioRun) => run.actionCompletion && Array.every(run.results, isPassing)

const describeResult = (result: RequirementResult) => `${result.requirement}=${result.status}`

class ScenarioPlan extends Schema.Class<ScenarioPlan>("ScenarioPlan")({
  catalog: Catalog,
  scenario: Scenario,
  artifacts: Schema.String,
  configuration: RunConfiguration,
  seed: Schema.Int,
  replay: OptionalReplayScenarioSchema,
}) {}

/** Plays one scenario against its own prepared server and browser and retains its scenario.json because every scenario is judged in isolation. */
const playScenario = (definition: AcceptanceDefinition, secrets: Ref.Ref<ReadonlyArray<Secret>>, jev: Layer.Layer<DecisionModel>) => Effect.fn("Acceptance.playScenario")(function* (plan: ScenarioPlan) {
  const evidence = yield* RunEvidence
  const fixtures = yield* FixtureRuntime
  const { catalog, scenario, artifacts, configuration } = plan
  const actor = yield* findById(catalog.actors, "actor", scenario.actor)
  const unprepared = unpreparedFixture(scenario, actor)

  const execution = Effect.gen(function* () {
    const fixture = yield* fixtures.prepare(scenario, actor.binding, artifacts)
    const retained = yield* fixtures.secrets(fixture)

    yield* Ref.update(secrets, Array.appendAll(retained))

    const target = BrowserTarget.make({ url: fixture.url, artifacts })
    const browser = browserLayer(target)
    const observations = Array.map(scenario.observations, definition.observationOperation)

    const input = ScenarioInput.make({
      catalog,
      scenario,
      actor,
      fixture,
      artifacts,
      configuration,
      seed: plan.seed,
      replay: plan.replay,
      observations,
      submissionProbes: definition.submissionProbes,
      directProbes: definition.directProbes,
    })

    return yield* pipe(executeScenario(input), Effect.provide(browser), Effect.provide(jev))
  })

  const run = yield* pipe(execution, Effect.scoped, Effect.catch(blockedRun(catalog, scenario, unprepared, artifacts)))
  const scenarioPath = join(artifacts, "scenario.json")

  yield* evidence.save(scenarioPath, ScenarioRun, run)

  return run
})

const listedIn = (values: ReadonlyArray<string>) => (value: string): boolean => Array.contains(values, value)

/**
 * Rejects definition-level probes the runtime cannot honor because an unknown submission probe would be silently skipped and an
 * unknown direct-probe operation would audit nothing.
 */
export const validateDefinition = Effect.fn("Acceptance.validateDefinition")(function* (definition: AcceptanceDefinition, probes: ReadonlyArray<string>) {
  const operations = pipe(definition.application, nativeOperations, Array.map(Struct.get("_tag")))
  const unknownProbes = Array.filter(definition.submissionProbes, Predicate.not(listedIn(probes)))
  const unknownOperations = Array.filter(definition.directProbes, Predicate.not(listedIn(operations)))
  const unknownProbe = (probe: string) => `Submission probe ${probe} is not implemented by the fixture runtime`
  const unknownOperation = (operation: string) => `Direct probe ${operation} is not a native operation of ${definition.name}`
  const problems = [...Array.map(unknownProbes, unknownProbe), ...Array.map(unknownOperations, unknownOperation)]
  const message = Array.join(problems, "; ")

  if (Array.isReadonlyArrayNonEmpty(problems)) return yield* runnerFailure("definition")(message)
})

const validatedCatalog = Effect.fn("Acceptance.validatedCatalog")(function* (definition: AcceptanceDefinition) {
  const fixtures = yield* FixtureRuntime

  const bindings = CatalogBindings.make({
    evaluators: definition.evaluators,
    fixtures: fixtures.bindings,
    actors: fixtures.actors,
    facts: fixtures.facts,
    probes: fixtures.probes,
  })

  yield* validateDefinition(definition, fixtures.probes)

  return yield* validateCatalog(definition.catalog, bindings, definition.application, definition.observationOperation)
})

const unfinished = Option.none<string>()

const undecided = Option.none<typeof RunStatusSchema.Type>()

const occupiedOutput = runnerFailure("evidence")("Output already contains run.json; choose a fresh directory to preserve previous evidence")

const missingKey = runnerFailure("decision")("TYPESAFE_API_KEY is required for real Jev exploration (never a mock fallback)")

const apiKeyConfig = pipe(Config.redacted("TYPESAFE_API_KEY"), Config.option)

/**
 * Explores every catalog scenario with Jev, or re-executes a recorded run without a model, into one fresh output directory.
 * The run passes only when every scenario completed its actions, every requirement passed, and no retained file contains a secret.
 */
export const runAcceptance = Effect.fn("Acceptance.run")(function* (definition: AcceptanceDefinition, configuration: RunConfiguration) {
  const evidence = yield* RunEvidence
  const catalog = yield* validatedCatalog(definition)
  const output = yield* evidence.directory(configuration.output)
  const runPath = join(output, "run.json")
  const alreadyExists = yield* evidence.exists(runPath)

  if (alreadyExists) return yield* occupiedOutput

  const build = yield* evidence.identify(definition.catalog)
  const pendingReplay = Option.map(configuration.replay, loadReplay(definition.name, build, catalog))
  const replay = yield* Effect.transposeOption(pendingReplay)
  const exploring = Option.isNone(replay)
  const apiKey = yield* apiKeyConfig
  const keyless = Option.isNone(apiKey)
  const unkeyed = exploring && keyless

  if (unkeyed) return yield* missingKey

  const startedAt = yield* now
  const mode = exploring ? "exploration" : "replay"

  const retainedConfiguration = RetainedConfiguration.make({
    model: configuration.model,
    minimumConfidence: configuration.minimumConfidence,
    maxActions: configuration.maxActions,
    deadlineSeconds: configuration.deadlineSeconds,
    seed: configuration.seed,
    mode,
    replay: configuration.replay,
  })

  const runs = yield* Ref.make<ReadonlyArray<ScenarioRun>>([])
  const initialSecrets = Option.toArray(apiKey)
  const secrets = yield* Ref.make<ReadonlyArray<Secret>>(initialSecrets)
  const key = Option.getOrElse(apiKey, Function.constant(emptyKey))
  const jevConfiguration = JevConfiguration.make({ apiKey: key, model: configuration.model })
  const jev = jevLayer(jevConfiguration)

  const report = (scenarios: ReadonlyArray<ScenarioRun>, evidenceLeaks: ReadonlyArray<string>, finishedAt: Option.Option<string>, status: Option.Option<typeof RunStatusSchema.Type>) =>
    RunReport.make({ application: definition.name, startedAt, catalog, build, configuration: retainedConfiguration, scenarios, evidenceLeaks, finishedAt, status })

  const initialReport = report([], [], unfinished, undecided)

  yield* evidence.save(runPath, RunReport, initialReport)

  const runScenario = Effect.fn("Acceptance.runScenario")(function* (scenario: Scenario, index: number) {
    const artifactsName = encodeURIComponent(scenario.id)
    const artifactsPath = join(output, artifactsName)
    const artifacts = yield* evidence.directory(artifactsPath)
    const recorded = Option.flatMap(replay, byRecordedScenario(scenario))
    const seed = configuration.seed + index
    const plan = ScenarioPlan.make({ catalog, scenario, artifacts, configuration, seed, replay: recorded })
    const run = yield* playScenario(definition, secrets, jev)(plan)
    const scenarios = yield* Ref.updateAndGet(runs, Array.append(run))
    const progressReport = report(scenarios, [], unfinished, undecided)
    const summary = pipe(run.results, Array.map(describeResult), Array.join(", "))

    yield* evidence.save(runPath, RunReport, progressReport)
    yield* Effect.logInfo(`${scenario.id}: actionCompletion=${run.actionCompletion}; ${summary}`)
  })

  yield* Effect.forEach(catalog.scenarios, runScenario, { discard: true })

  const scenarios = yield* Ref.get(runs)
  const retainedSecrets = yield* Ref.get(secrets)
  const leaks = yield* evidence.scan(output, retainedSecrets)
  const sealed = Array.isReadonlyArrayEmpty(leaks)
  const passed = sealed && Array.every(scenarios, scenarioPassed)
  const status = passed ? "pass" : "not-passed"
  const finishedAt = yield* now
  const finishedAtOption = Option.some(finishedAt)
  const statusOption = Option.some<typeof RunStatusSchema.Type>(status)
  const finished = report(scenarios, leaks, finishedAtOption, statusOption)
  const leakList = Array.join(leaks, ", ")

  yield* evidence.save(runPath, RunReport, finished)

  if (!sealed) yield* Effect.logError(`Retained evidence contains a secret value: ${leakList}`)

  yield* Effect.logInfo(`${definition.title} (${definition.name}) ${mode} ${status}; evidence ${runPath}`)

  return passed
})
