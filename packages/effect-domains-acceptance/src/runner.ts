import { Array, Clock, DateTime, Deferred, Duration, Effect, Equal, Equivalence, Fiber, Function, type Layer, Number, Option, Order, Predicate, Record, Redacted, Ref, Result, Schema, type Scope, Struct, Tuple, flow, pipe } from "effect"
import type { ApplicationIR } from "effect-domains/application"
import { join, relative } from "node:path"
import { BrowserTarget, browserLayer } from "./browser.ts"
import { AssessedRequirement, ratedAssessment, unratedAssessment } from "./assessment.ts"
import { BoundAssessment, CatalogBindings, type ValidatedCatalog, amongst, validateCatalog } from "./catalog.ts"
import { JevConfiguration, jevLayer } from "./decision.ts"
import { type Fault, type FaultContext, FaultDeclaration, serveFaultProxy } from "./faults.ts"
import { type EvidencePolicy, LineageBuild, LineageFacts, LineageRepair, LineageResult, type Seal, claimOwnership, recordLineage, replaySource, seal, sealFindings } from "./governance.ts"
import { type Secret, call } from "./server.ts"
import { type SurfaceBinding, type SurfaceDeclaration, SurfaceIdentity, repairMatch, surfaceFor, surfaceIdentity, validateSurfaces } from "./surface.ts"

import {
  AcceptanceError,
  Action,
  Actor,
  AssessmentEvidence,
  AssessmentRequest,
  AssessmentRun,
  BarrierArrival,
  BarrierRecord,
  BoundRequirement,
  BrowserSurface,
  BuildIdentity,
  Candidate,
  Catalog,
  ContendedSchema,
  Decision,
  DecisionModel,
  DecisionState,
  DeniedSchema,
  EvaluationContext,
  FileHashSchema,
  FixtureRuntime,
  InputCandidates,
  LocatorRepair,
  Observation,
  Offer,
  PayloadSchema,
  PreparedFixture,
  ProbeRecord,
  ProbeTarget,
  RequestGate,
  RequirementCategorySchema,
  RequirementEvaluation,
  RejectedSchema,
  RequirementResult,
  RunEvidence,
  Scenario,
  ScenarioRun,
  Submission,
  TraceEntry,
  WatchRecord,
  type Concurrency,
  type InputCase,
  type Lane,
  type Payload,
  type RequestHold,
  type Watch,
} from "./model.ts"

const OptionalPathSchema = Schema.OptionFromOptionalKey(Schema.String)
const OptionalKeySchema = Schema.OptionFromOptionalKey(Schema.Redacted(Schema.String))

/** `repairLocators` permits semantics-preserving locator repair of a replay; `fault` routes a replay's fault scenario through that declared fault's proxy. */
export class RunConfiguration extends Schema.Class<RunConfiguration>("RunConfiguration")({
  output: Schema.String,
  seed: Schema.Int,
  model: Schema.String,
  minimumConfidence: Schema.Number,
  maxActions: Schema.Int,
  deadlineSeconds: Schema.Int,
  replay: OptionalPathSchema,
  repairLocators: Schema.Boolean,
  fault: OptionalPathSchema,
  apiKey: OptionalKeySchema,
}) {}

export interface AcceptanceDefinition {
  readonly name: string
  readonly format: string
  readonly title: string
  readonly catalog: typeof Catalog.Encoded
  /** The registry of importable catalogs because imports resolve only against explicitly supplied declarations. */
  readonly catalogs: ReadonlyArray<typeof Catalog.Encoded>
  readonly application: ApplicationIR
  readonly evaluators: Readonly<{ readonly [evaluator: string]: string }>
  readonly advanced: ReadonlyArray<string>
  readonly unexercised: ReadonlyArray<string>
  /** The verifier report is encoded because run.json and verifier.json retain the encoded report. */
  readonly verifier: Effect.Effect<unknown, AcceptanceError>
  readonly observationOperation: (resource: string) => string
  /** Probes taken after each accepted submission because hidden state must be read at every step, not only at the end. */
  readonly submissionProbes: ReadonlyArray<string>
  /** Operations re-called directly after the run because enforcement must be proven server-side, not only through the UI. */
  readonly directProbes: ReadonlyArray<string>
  readonly defaultMaxActions: number
  /** Faults are application-owned because only the application can shape a defect in its own native contracts. */
  readonly faults: ReadonlyArray<Fault>
  /** The evidence policy is application-owned because only the application knows which probes and operations return protected records. */
  readonly policy: EvidencePolicy
  /** Explicit custom-UI bindings because authored surfaces are never discovered by a global selector heuristic. */
  readonly surfaces: ReadonlyArray<SurfaceDeclaration>
}

class ReplayTraceEntry extends Schema.Class<ReplayTraceEntry>("ReplayTraceEntry")({
  lane: OptionalPathSchema,
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

const FileHashesSchema = Schema.Array(FileHashSchema)

class ReplayBuild extends Schema.Class<ReplayBuild>("ReplayBuild")({
  sha256: Schema.String,
  files: FileHashesSchema,
  catalogHash: Schema.String,
  nativeContractsHash: Schema.String,
}) {}

const ReplayScenariosSchema = Schema.Array(ReplayScenario)
const SurfaceIdentitiesSchema = Schema.Array(SurfaceIdentity)
const OptionalSurfaceIdentitiesSchema = Schema.OptionFromOptionalKey(SurfaceIdentitiesSchema)

class Replay extends Schema.Class<Replay>("Replay")({
  format: Schema.NonEmptyString,
  build: ReplayBuild,
  surfaces: OptionalSurfaceIdentitiesSchema,
  scenarios: ReplayScenariosSchema,
}) {}

const ChangedFilesSchema = Schema.Array(Schema.String)

/** A loaded replay with the presentation-only files that changed since it was recorded, accepted only in repair mode. */
class CheckedReplay extends Schema.Class<CheckedReplay>("CheckedReplay")({
  replay: Replay,
  presentation: ChangedFilesSchema,
}) {}

class Viewport extends Schema.Class<Viewport>("Viewport")({
  width: Schema.Int,
  height: Schema.Int,
}) {}

class BrowserConfiguration extends Schema.Class<BrowserConfiguration>("BrowserConfiguration")({
  engine: Schema.String,
  playwright: Schema.String,
  viewport: Viewport,
  context: Schema.String,
}) {}

const RunModeSchema = Schema.Literals(["recorded-replay", "repaired-replay", "real-jev-exploration"])
const SourceReplaySchema = Schema.OptionFromNullOr(Schema.String)

class RetainedConfiguration extends Schema.Class<RetainedConfiguration>("RetainedConfiguration")({
  model: Schema.String,
  minimumConfidence: Schema.Number,
  maxActions: Schema.Int,
  deadlineSeconds: Schema.Int,
  seed: Schema.Int,
  browser: BrowserConfiguration,
  mode: RunModeSchema,
  sourceReplay: SourceReplaySchema,
}) {}

class StrictInterruption extends Schema.Class<StrictInterruption>("StrictInterruption")({
  scenario: Schema.String,
  interruption: Schema.String,
}) {}

const StrictInterruptionsSchema = Schema.Array(StrictInterruption)

/** Links a repaired replay to its preserved strict attempt because the original locator failure must stay inspectable next to the repairs. */
class RepairSummary extends Schema.Class<RepairSummary>("RepairSummary")({
  strictAttempt: Schema.String,
  strictStatus: Schema.String,
  strictInterruptions: StrictInterruptionsSchema,
  repaired: Schema.Int,
}) {}

const InjectionsSchema = Schema.Array(Schema.String)

/** A declared fault routed into a replay because wrong-target controls must exercise repair refusal on the real browser path. */
class ReplayControl extends Schema.Class<ReplayControl>("ReplayControl")({
  fault: FaultDeclaration,
  injections: InjectionsSchema,
}) {}

const LedgerEntriesSchema = Schema.Array(Schema.String)

class Ledger extends Schema.Class<Ledger>("Ledger")({
  advanced: LedgerEntriesSchema,
  closed: LedgerEntriesSchema,
  unexercised: LedgerEntriesSchema,
}) {}

const CoverageStatusSchema = Schema.Literals(["pass", "fail", "blocked", "inconclusive", "missing"])

class Coverage extends Schema.Class<Coverage>("Coverage")({
  requirement: Schema.String,
  scenario: Schema.String,
  result: CoverageStatusSchema,
  text: Schema.String,
  category: RequirementCategorySchema,
}) {}

const ScenarioRunsSchema = Schema.Array(ScenarioRun)
const CoveragesSchema = Schema.Array(Coverage)
const FullSystemCompletionSchema = Schema.Literal(false)

const VerifierCountsSchema = Schema.Struct({
  falseAcceptance: Schema.Number,
  falseRejection: Schema.Number,
  unexpectedStatuses: Schema.Number,
})

interface VerifierCounts extends Schema.Schema.Type<typeof VerifierCountsSchema> {}

class VerifierHeadline extends Schema.Class<VerifierHeadline>("VerifierHeadline")({
  summary: VerifierCountsSchema,
}) {}

const OptionalFinishedSchema = Schema.OptionFromOptionalKey(Schema.String)
const SliceStatusSchema = Schema.Literals(["pass", "not-passed"])
const OptionalSliceStatusSchema = Schema.OptionFromOptionalKey(SliceStatusSchema)
const LeaksSchema = Schema.Array(Schema.String)
const OptionalPresentationSchema = Schema.OptionFromOptionalKey(ChangedFilesSchema)
const OptionalRepairSummarySchema = Schema.OptionFromOptionalKey(RepairSummary)
const OptionalControlSchema = Schema.OptionFromOptionalKey(ReplayControl)

/**
 * `surfaces` retains each custom binding's semantic identity so a later repair can prove only presentation changed; `presentationChange`
 * lists the presentation-only files a repair-mode replay accepted; `repair` links a repaired replay to its preserved strict attempt.
 */
class RunReport extends Schema.Class<RunReport>("RunReport")({
  format: Schema.NonEmptyString,
  startedAt: Schema.String,
  catalog: Catalog,
  build: BuildIdentity,
  surfaces: SurfaceIdentitiesSchema,
  fixtureRevision: Schema.String,
  configuration: RetainedConfiguration,
  presentationChange: OptionalPresentationSchema,
  repair: OptionalRepairSummarySchema,
  control: OptionalControlSchema,
  scenarios: ScenarioRunsSchema,
  verifier: Schema.Unknown,
  fullSystemCompletion: FullSystemCompletionSchema,
  ledger: Ledger,
  coverage: CoveragesSchema,
  evidenceLeaks: LeaksSchema,
  finishedAt: OptionalFinishedSchema,
  sliceStatus: OptionalSliceStatusSchema,
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

const OptionalSubmissionSchema = Schema.OptionFromOptionalKey(Submission)

class Closing extends Schema.Class<Closing>("Closing")({
  after: ObservationsSchema,
  probes: ProbeRecordsSchema,
  directProbe: OptionalSubmissionSchema,
}) {}

const OptionalReplayScenarioSchema = Schema.OptionFromOptionalKey(ReplayScenario)

const BoundRequirementsSchema = Schema.Array(BoundRequirement)
const BoundAssessmentsSchema = Schema.Array(BoundAssessment)

/** `target` is the browser target lanes beyond the first open their own isolated context against, and `assessments` the scenario's bound non-gating reviews. */
class ScenarioInput extends Schema.Class<ScenarioInput>("ScenarioInput")({
  catalog: Catalog,
  requirements: BoundRequirementsSchema,
  assessments: BoundAssessmentsSchema,
  scenario: Scenario,
  actor: Actor,
  fixture: PreparedFixture,
  target: BrowserTarget,
  artifacts: Schema.String,
  configuration: RunConfiguration,
  seed: Schema.Int,
  replay: OptionalReplayScenarioSchema,
  observations: NamesSchema,
  submissionProbes: NamesSchema,
  directProbes: NamesSchema,
}) {}

const OptionalDecisionSchema = Schema.OptionFromOptionalKey(Decision)
const OptionalRepairSchema = Schema.OptionFromOptionalKey(LocatorRepair)

class Chosen extends Schema.Class<Chosen>("Chosen")({
  action: Action,
  decision: OptionalDecisionSchema,
  repair: OptionalRepairSchema,
}) {}

const IdentifiedSchema = Schema.Struct({ id: Schema.String })

interface Identified extends Schema.Schema.Type<typeof IdentifiedSchema> {}

class TaggedFailure extends Schema.Class<TaggedFailure>("TaggedFailure")({
  _tag: Schema.String,
}) {}

const viewport = Viewport.make({ width: 1280, height: 900 })

const browserConfiguration = BrowserConfiguration.make({
  engine: "chromium",
  playwright: "1.64.0",
  viewport,
  context: "fresh-per-scenario",
})

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

const fillMatches = (value: Option.Option<Payload>) => flow(Struct.get<Action, "value">("value"), sameValue(value))

// A filled or custom-bound action carries its payload in the action itself because the bound row identity travels in that payload.
const payloadMatches = (recorded: Action, value: Option.Option<Payload>) => {
  const filled = Equal.equals(recorded.kind, "fill")
  const bound = Option.isSome(recorded.binding)
  const carried = filled || bound

  return carried ? fillMatches(value) : Function.constTrue
}

const matchesRecorded = (recorded: Action, value: Option.Option<Payload>) => (option: Action) => {
  const sameId = Equal.equals(option.id, recorded.id)
  const sameKind = Equal.equals(option.kind, recorded.kind)
  const sameOperation = Equal.equals(option.operation, recorded.operation)
  const sameInputCase = Equal.equals(option.inputCase, recorded.inputCase)
  const sameTarget = Equal.equals(option.target, recorded.target)
  const identity = sameId && sameKind
  const placement = sameOperation && sameTarget
  const located = identity && placement
  const bound = located && sameInputCase

  return bound && payloadMatches(recorded, value)(option)
}

const byCandidateCase = (inputCase: Option.Option<string>) => (candidate: Candidate) => Option.contains(inputCase, candidate.inputCase)

const resolvedValue = (recorded: Action, available: ReadonlyArray<Candidate>) =>
  pipe(available, Array.findFirst(byCandidateCase(recorded.inputCase)), Option.map(Struct.get("input")))

const consumedCases = (progress: Progress) => Array.map(progress.submissions, Struct.get("inputCase"))

const consumedBy = (consumed: ReadonlyArray<string>) => (id: string) => Array.contains(consumed, id)

const unconsumed = (consumed: ReadonlyArray<string>) => (candidate: Candidate) => Predicate.not(consumedBy(consumed))(candidate.inputCase)

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

const byId = (id: string) => (entry: Identified) => Equal.equals(entry.id, id)

const findById = <A extends Identified>(entries: ReadonlyArray<A>, kind: string, id: string) => {
  const missing = runnerFailure("catalog")(`Missing resolved ${kind} ${id}`)

  return pipe(entries, Array.findFirst(byId(id)), Effect.fromOption, Effect.mapError(Function.constant(missing)))
}

const isDeniedOutcome = Schema.is(DeniedSchema)
const isRejectedOutcome = Schema.is(RejectedSchema)
const isContendedOutcome = Schema.is(ContendedSchema)
const purposefulRefusal = "submitting it is the purpose of this check, so enter and submit it"

const refusalResponse = (outcome: Readonly<{ failure: string }>) => `the application refuses it with ${outcome.failure}; ${purposefulRefusal}`

const rejectionResponse = `the application rejects it as input outside the native contract; ${purposefulRefusal}`

const contendedResponse = (outcome: Readonly<{ failures: ReadonlyArray<string> }>) => `a competing submission races it, so the application either accepts it or refuses it with ${Array.join(outcome.failures, " or ")}; ${purposefulRefusal}`

const expectedResponse = (input: InputCase) => {
  if (isDeniedOutcome(input.outcome)) return refusalResponse(input.outcome)

  if (isContendedOutcome(input.outcome)) return contendedResponse(input.outcome)

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

const probeTarget = (probe: Scenario["probes"][number], phase: string) => (subject: string) => ProbeTarget.make({ probe, phase, subject })

const probeFor = (phase: string, subject: string) => (probe: string) => ProbeTarget.make({ probe, phase, subject })

const targetsFor = (phase: string, subjects: ReadonlyArray<string>) => (probe: Scenario["probes"][number]) => Array.map(subjects, probeTarget(probe, phase))

const probeTargets = (scenario: Scenario, phase: string, subjects: ReadonlyArray<string>) => Array.flatMap(scenario.probes, targetsFor(phase, subjects))

const probeSubject = (fixture: PreparedFixture) => Effect.fn("Acceptance.probeSubject")(function* (target: ProbeTarget) {
  const runtime = yield* FixtureRuntime

  return yield* runtime.probe(fixture, target)
})

const candidatePool = Effect.fn("Acceptance.candidatePool")(function* (input: ScenarioInput, submissions: ReadonlyArray<Submission>) {
  const inputs = yield* InputCandidates

  return yield* Option.match(input.replay, {
    onNone: () => inputs.resolve(input.scenario, input.fixture, submissions, input.catalog.textFixtures, input.seed),
    onSome: (recording) => inputs.replay(input.scenario, recording.candidates, input.fixture, submissions, input.catalog.textFixtures),
  })
})

const describeDiagnosis = (error: AcceptanceError) => Effect.succeed(`not diagnosable (${error.message})`)

const refusedRepair = (original: AcceptanceError) => (error: AcceptanceError) => runnerFailure("repair")(`Locator repair refused: ${error.message}; original failure retained: ${original.message}`)

/**
 * Handles a recorded action that strict replay cannot find. The recorded action is first rebound to the current candidate payload because
 * fixtures issue fresh identities; its declared locators are diagnosed on the live page so the failure is retained. Only in repair mode, and
 * only for a custom-binding action, the single offered action with the identical semantic target is verified live and chosen with provenance.
 */
const unavailableRecorded = Effect.fn("Acceptance.unavailableRecorded")(function* (input: ScenarioInput, recorded: Action, options: ReadonlyArray<Action>) {
  const surface = yield* BrowserSurface
  const custom = Option.isSome(recorded.binding)
  const diagnosis = custom ? yield* pipe(surface.diagnose(recorded), Effect.catch(describeDiagnosis)) : "a generated-UI action has no declared custom locator"
  const failed = runnerFailure("replay")(`Recorded action ${recorded.id} is no longer available; original failure retained, no skipped criterion; its recorded locators now resolve: ${diagnosis}`)
  const repairable = custom && input.configuration.repairLocators

  if (!repairable) return yield* failed

  const refused = refusedRepair(failed)
  const match = yield* pipe(repairMatch(recorded, options), Effect.mapError(refused))
  const repair = yield* pipe(surface.repair(recorded, match), Effect.mapError(refused))

  return Chosen.make({ action: match, decision: Option.none(), repair: Option.some(repair) })
})

const strictChosen = (action: Action) => Chosen.make({ action, decision: Option.none(), repair: Option.none() })

const strictChoice = flow(strictChosen, Effect.succeed)

const reboundAction = (recorded: Action, value: Option.Option<Payload>) => {
  const keep = Function.constant(recorded.value)

  return Action.make({ ...recorded, value: Option.orElse(value, keep) })
}

const recordedChoice = Effect.fn("Acceptance.recordedChoice")(function* (input: ScenarioInput, state: Ref.Ref<Progress>, recording: ReplayScenario, options: ReadonlyArray<Action>, available: ReadonlyArray<Candidate>, step: number, lane: Option.Option<string>) {
  const entry = yield* pipe(recording.trace, Array.get(step), Effect.fromOption, Effect.mapError(Function.constant(recordingExhausted)))
  const value = resolvedValue(entry.action, available)
  const rebound = reboundAction(entry.action, value)
  const strict = Array.findFirst(options, matchesRecorded(entry.action, value))
  const unavailable = unavailableRecorded(input, rebound, options)
  const chosen = yield* Option.match(strict, { onNone: Function.constant(unavailable), onSome: strictChoice })

  if (!entry.executed) {
    const at = yield* now
    const progress = yield* Ref.get(state)
    const interrupted = TraceEntry.make({ at, lane, action: chosen.action, executed: false, decision: Option.none(), observation: progress.view, repair: chosen.repair })

    yield* Ref.update(state, appendTrace(interrupted))

    return yield* runnerFailure("replay")(`Recorded action ${entry.action.id} was not executed; original interruption is preserved`)
  }

  return chosen
})

const modelChoice = Effect.fn("Acceptance.modelChoice")(function* (input: ScenarioInput, progress: Progress, options: ReadonlyArray<Action>) {
  const model = yield* DecisionModel
  const view = yield* pipe(decisionView(input, progress), Schema.encodeEffect(DecisionView), Effect.mapError(describeDecisionFailure))
  const history = Array.map(progress.trace, describe)
  const state = DecisionState.make({ goal: input.scenario.goal, view, history })
  const decision = yield* model.choose(state, options)
  const action = yield* pipe(options, Array.findFirst(byId(decision.choice)), Effect.fromOption, Effect.mapError(Function.constant(noAvailableAction)))

  return Chosen.make({ action, decision: Option.some(decision), repair: Option.none() })
})

const belowConfidence = (configuration: RunConfiguration) => (decision: Decision) => Order.isLessThan(Order.Number)(decision.confidence, configuration.minimumConfidence)

const confidenceGate = Effect.fn("Acceptance.confidenceGate")(function* (configuration: RunConfiguration, decision: Option.Option<Decision>) {
  const low = Option.filter(decision, belowConfidence(configuration))

  if (Option.isSome(low)) {
    return yield* runnerFailure("decision")(`Confidence ${low.value.confidence} is below configured ${configuration.minimumConfidence}; action not executed`)
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

/**
 * What the harness does immediately before a lane executes its chosen action, because only the harness may hold a declared barrier or start
 * a declared watch; `lane` tags the lane's trace entries so a replay can rebind each lane's recorded actions.
 */
interface SubmitGate {
  readonly lane: Option.Option<string>
  readonly before: (action: Action) => Effect.Effect<void, AcceptanceError, FixtureRuntime | Scope.Scope>
  readonly requests: RequestHold
}

const unheldRequests: RequestHold = Option.none()

const interact: (input: ScenarioInput, state: Ref.Ref<Progress>, step: number, gate: SubmitGate) => Effect.Effect<void, AcceptanceError, BrowserSurface | DecisionModel | InputCandidates | FixtureRuntime | Scope.Scope> = Effect.fn("Acceptance.interact")(function* (input: ScenarioInput, state: Ref.Ref<Progress>, step: number, gate: SubmitGate) {
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
  const chosen = Option.isSome(input.replay) ? yield* recordedChoice(input, state, input.replay.value, options, available, step, gate.lane) : yield* modelChoice(input, progress, options)
  const at = yield* now
  const { lane } = gate
  const pending = TraceEntry.make({ at, lane, action: chosen.action, executed: false, decision: chosen.decision, observation: progress.view, repair: chosen.repair })

  yield* Ref.update(state, appendTrace(pending))
  yield* confidenceGate(input.configuration, chosen.decision)

  if (Equal.equals(chosen.action.kind, "cannot-proceed")) {
    return yield* cannotProceed
  }

  const fingerprint = fingerprintOf(chosen.action)
  const counted = yield* Ref.updateAndGet(state, tallyAction(fingerprint))
  const count = pipe(counted.repeated, Record.get(fingerprint), Option.getOrElse(Function.constant(0)))

  if (Order.isGreaterThan(Order.Number)(count, 2)) {
    return yield* runnerFailure("progress")(`Repeated action without completion: ${chosen.action.id}`)
  }

  yield* gate.before(chosen.action)

  const outcome = yield* pipe(surface.execute(chosen.action), Effect.provideService(RequestGate, gate.requests))
  const executing = TraceEntry.make({ at, lane, action: chosen.action, executed: true, decision: chosen.decision, observation: progress.view, repair: chosen.repair })

  yield* Ref.update(state, replaceTrace(executing))
  yield* recordSubmission(input, state, available, outcome)

  const moved = yield* Ref.updateAndGet(state, navigated(chosen.action))
  const screenshot = join(input.artifacts, `step-${step + 1}.png`)
  const view = yield* surface.observe(moved.reloaded, screenshot)
  const executed = TraceEntry.make({ at, lane, action: chosen.action, executed: true, decision: chosen.decision, observation: view, repair: chosen.repair })
  const latest = yield* Ref.updateAndGet(state, observed(view, executed))

  if (isComplete(input.scenario, latest)) {
    return
  }

  return yield* interact(input, state, step + 1, gate)
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

const byDirectProbe = (scenario: Scenario, operations: ReadonlyArray<string>) => (inputCase: InputCase) => {
  const required = Array.contains(scenario.required, inputCase.id)
  const direct = Array.contains(operations, inputCase.operation)

  return required && direct
}

const directEnforcement = Effect.fn("Acceptance.directEnforcement")(function* (input: ScenarioInput, progress: Progress) {
  const audited = pipe(input.scenario.inputs, Array.findFirst(byDirectProbe(input.scenario, input.directProbes)), Option.map(Struct.get("id")))

  if (Option.isNone(audited)) {
    return Option.none<Submission>()
  }

  const pool = yield* candidatePool(input, progress.submissions)
  const candidates = Array.appendAll(progress.candidates, pool)
  const unresolved = runnerFailure("scope")(`No resolved candidate for direct enforcement probe ${audited.value}`)
  const candidate = yield* pipe(candidates, Array.findFirst(byCandidateCase(audited)), Effect.fromOption, Effect.mapError(Function.constant(unresolved)))
  const runtime = yield* FixtureRuntime
  const submission = yield* runtime.direct(input.fixture, candidate)

  return Option.some(submission)
})

const closingEvidence = Effect.fn("Acceptance.closingEvidence")(function* (input: ScenarioInput, progress: Progress) {
  const lists = observedLists(input)
  const after = yield* Effect.forEach(lists, captureList(input.artifacts, "after", progress.reloaded))
  const captured = capturedCases(progress.submissions)
  const tracked = trackedSubjects(input.fixture)
  const subjects = pipe(tracked, Array.appendAll(captured), Array.dedupe)
  const targets = probeTargets(input.scenario, "after", subjects)
  const probes = yield* Effect.forEach(targets, probeSubject(input.fixture))
  const directProbe = yield* directEnforcement(input, progress)

  return Closing.make({ after, probes, directProbe })
})

const unresolvedResult = (requirement: BoundRequirement, scenario: Scenario, status: "blocked" | "inconclusive", evidence: ReadonlyArray<string>) => (explanation: string) =>
  RequirementResult.make({
    requirement: requirement.reference,
    requirementRevision: requirement.revision,
    scenario: scenario.id,
    scenarioRevision: scenario.revision,
    evaluator: requirement.evaluator,
    evaluatorRevision: requirement.evaluatorRevision,
    basis: "executable assertion",
    status,
    explanation,
    evidence,
  })

const evaluatorExplanation = (error: AcceptanceError) => `Evaluator failed: ${error}`

const inconclusive = (requirement: BoundRequirement, scenario: Scenario, evidence: ReadonlyArray<string>) =>
  flow(evaluatorExplanation, unresolvedResult(requirement, scenario, "inconclusive", evidence), Effect.succeed)

const byReference = (reference: string) => (bound: Readonly<{ reference: string }>) => Equal.equals(bound.reference, reference)

const findRequirement = (requirements: ReadonlyArray<BoundRequirement>, reference: string) => {
  const missing = runnerFailure("catalog")(`Missing resolved requirement ${reference}`)

  return pipe(requirements, Array.findFirst(byReference(reference)), Effect.fromOption, Effect.mapError(Function.constant(missing)))
}

const evaluateRequirement = (requirements: ReadonlyArray<BoundRequirement>, context: EvaluationContext) =>
  Effect.fn("Acceptance.evaluateRequirement")(function* (reference: string) {
    const evaluator = yield* RequirementEvaluation
    const requirement = yield* findRequirement(requirements, reference)

    return yield* pipe(evaluator.evaluate(requirement, context), Effect.catch(inconclusive(requirement, context.scenario, context.evidence)))
  })

const unevaluated = (requirements: ReadonlyArray<BoundRequirement>, scenario: Scenario, status: "blocked" | "inconclusive", explanation: string, evidence: ReadonlyArray<string>) =>
  Effect.fn("Acceptance.unevaluated")(function* (reference: string) {
    const requirement = yield* findRequirement(requirements, reference)

    return unresolvedResult(requirement, scenario, status, evidence)(explanation)
  })

const screenshotsOf = (observations: ReadonlyArray<Observation>) => pipe(observations, Array.map(Struct.get("screenshot")), Array.getSomes)

const failureText = (cause: unknown) => `${cause}`

const failureOf = <A, E>(result: Result.Result<A, E>) => pipe(result, Result.getFailure, Option.map(failureText))

const emptyClosing = Closing.make({ after: [], probes: [], directProbe: Option.none() })

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

class WatchResult extends Schema.Class<WatchResult>("WatchResult")({
  records: ProbeRecordsSchema,
  record: WatchRecord,
}) {}

type WatchFiber = Fiber.Fiber<WatchResult, AcceptanceError>

type Starter = (action: Action) => Effect.Effect<void, AcceptanceError, FixtureRuntime | Scope.Scope>

const observedState = (field: string) => (record: ProbeRecord) => pipe(
  record.result,
  Option.flatMap(Schema.decodeUnknownOption(PayloadSchema)),
  Option.flatMap(Record.get(field)),
  Option.filter(Predicate.isString),
)

const watchSubject = (fixture: PreparedFixture, watch: Watch) => {
  const missing = runnerFailure("watch")(`The fixture does not provide the watched subject fact ${watch.subject}`)

  return pipe(fixture.facts, Record.get(watch.subject), Option.filter(Predicate.isString), Effect.fromOption, Effect.mapError(Function.constant(missing)))
}

const watchTarget = (watch: Watch, subject: string) => (index: number) => ProbeTarget.make({ probe: watch.probe, phase: `watch:${index}`, subject })

const noOffsets = Array.empty<number>()

const confirmationOffsets = (watch: Watch) => watch.confirmations > 0 ? Array.range(1, watch.confirmations) : noOffsets

const OptionalStateSchema = Schema.OptionFromOptionalKey(Schema.String)

class Polled extends Schema.Class<Polled>("Polled")({
  records: ProbeRecordsSchema,
  terminal: OptionalStateSchema,
}) {}

const noState = Option.none<string>()

/** Polls the watched probe at the declared interval until a terminal state (then the declared confirmations) or the deadline, keeping every observation. */
const pollWatch = (fixture: PreparedFixture, watch: Watch, subject: string, deadlineAt: number) => {
  const target = watchTarget(watch, subject)
  const interval = Duration.millis(watch.intervalMillis)
  const probeAt = flow(target, probeSubject(fixture))
  const offsets = confirmationOffsets(watch)
  const pause = Effect.sleep(interval)

  const confirm = (from: number) => (offset: number) => {
    const probing = probeAt(from + offset)

    return Effect.andThen(pause, probing)
  }

  const loop: (index: number, records: ReadonlyArray<ProbeRecord>) => Effect.Effect<Polled, AcceptanceError, FixtureRuntime> = Effect.fn("Acceptance.pollWatch")(function* (index: number, records: ReadonlyArray<ProbeRecord>) {
    const record = yield* probeAt(index)
    const observed = Array.append(records, record)
    const terminal = pipe(record, observedState(watch.field), Option.filter(amongst(watch.terminal)))

    if (Option.isSome(terminal)) {
      const confirmations = yield* Effect.forEach(offsets, confirm(index))
      const confirmed = Array.appendAll(observed, confirmations)

      return Polled.make({ records: confirmed, terminal })
    }

    const at = yield* Clock.currentTimeMillis
    const expired = at >= deadlineAt

    if (expired) return Polled.make({ records: observed, terminal: noState })

    yield* pause

    return yield* loop(index + 1, observed)
  })

  return loop(0, [])
}

const runWatch = Effect.fn("Acceptance.runWatch")(function* (fixture: PreparedFixture, watch: Watch) {
  const subject = yield* watchSubject(fixture, watch)
  const startedAt = yield* now
  const started = yield* Clock.currentTimeMillis
  const deadlineAt = started + watch.deadlineSeconds * 1000
  const polled = yield* pollWatch(fixture, watch, subject, deadlineAt)
  const endedAt = yield* now
  const outcome = Option.isSome(polled.terminal) ? "terminal" : "deadline"
  const polls = Array.length(polled.records)
  const record = WatchRecord.make({ watch, startedAt, endedAt, outcome, terminalState: polled.terminal, polls })

  return WatchResult.make({ records: polled.records, record })
})

const watchedBy = (action: Action) => (watch: Watch) => {
  const submitting = Equal.equals(action.kind, "submit")

  return submitting && Option.contains(action.inputCase, watch.input)
}

/** Starts the declared watch in the scenario scope just before the watched submission executes, because transitions must be observed while the request is still in flight. */
const watchStarter = (fixture: PreparedFixture, watch: Option.Option<Watch>, started: Ref.Ref<Option.Option<WatchFiber>>): Starter => Effect.fn("Acceptance.startWatch")(function* (action: Action) {
  const running = yield* Ref.get(started)
  const idle = Option.isNone(running)
  const declared = pipe(watch, Option.filter(watchedBy(action)), Option.filter(Function.constant(idle)))

  if (Option.isNone(declared)) return

  const watching = runWatch(fixture, declared.value)
  const fiber = yield* Effect.forkScoped(watching)
  const handle = Option.some(fiber)

  yield* Ref.set(started, handle)
})

const joinWatch = Effect.fn("Acceptance.joinWatch")(function* (started: Ref.Ref<Option.Option<WatchFiber>>) {
  const fiber = yield* Ref.get(started)

  if (Option.isNone(fiber)) return Option.none<WatchResult>()

  const result = yield* Fiber.join(fiber.value)

  return Option.some(result)
})

/** The harness-owned barrier: every lane's first submitted request is held pending at the network boundary until all lanes hold theirs, then all are released together. */
interface Barrier {
  readonly arrive: (lane: string) => (inputCase: string) => Effect.Effect<void, AcceptanceError>
  readonly breakWith: (lane: string) => (cause: unknown) => Effect.Effect<void>
  readonly record: Effect.Effect<BarrierRecord>
}

const arrivedFrom = (lane: string) => flow(Struct.get<BarrierArrival, "lane">("lane"), Equal.equals(lane))

const makeBarrier = Effect.fn("Acceptance.makeBarrier")(function* (concurrency: Concurrency) {
  const lanes = Array.length(concurrency.lanes)
  const arrivals = yield* Ref.make<ReadonlyArray<BarrierArrival>>([])
  const releasedAt = yield* Ref.make(noState)
  const released = yield* Deferred.make<boolean, AcceptanceError>()

  const release = Effect.fn("Acceptance.releaseBarrier")(function* () {
    const at = yield* now
    const stamped = Option.some(at)

    yield* Ref.set(releasedAt, stamped)
    yield* Deferred.succeed(released, true)
  })

  const arrive = (lane: string) => Effect.fn("Acceptance.arriveAtBarrier")(function* (inputCase: string) {
    const recorded = yield* Ref.get(arrivals)
    const fresh = !Array.some(recorded, arrivedFrom(lane))

    if (!fresh) return

    const arrivedAt = yield* now
    const arrival = BarrierArrival.make({ lane, inputCase, arrivedAt })
    const updated = yield* Ref.updateAndGet(arrivals, Array.append(arrival))
    const arrived = Array.length(updated)
    const complete = Equal.equals(arrived, lanes)

    if (complete) yield* release()

    yield* Deferred.await(released)
  })

  const breakWith = (lane: string) => (cause: unknown) => {
    const reason = failureText(cause)
    const broken = runnerFailure("barrier")(`Lane ${lane} ended before the ${concurrency.barrier} barrier released: ${reason}`)

    return pipe(Deferred.fail(released, broken), Effect.asVoid)
  }

  const record = Effect.gen(function* () {
    const arrived = yield* Ref.get(arrivals)
    const at = yield* Ref.get(releasedAt)

    return BarrierRecord.make({ barrier: concurrency.barrier, lanes, arrivals: arrived, releasedAt: at })
  })

  const barrier: Barrier = { arrive, breakWith, record }

  return barrier
})

const OptionalLaneSchema = Schema.OptionFromOptionalKey(Schema.String)

class LaneOutcome extends Schema.Class<LaneOutcome>("LaneOutcome")({
  lane: OptionalLaneSchema,
  scenario: Scenario,
  progress: Progress,
  failure: OptionalFailureSchema,
}) {}

const LaneOutcomesSchema = Schema.Array(LaneOutcome)
const OptionalBarrierRecordSchema = Schema.OptionFromOptionalKey(BarrierRecord)

class Interactions extends Schema.Class<Interactions>("Interactions")({
  lanes: LaneOutcomesSchema,
  barrier: OptionalBarrierRecordSchema,
}) {}

const ignoreFailure = Function.constant(Effect.void)

const watchLane = Option.some("watch")

const runLane = (input: ScenarioInput, gate: SubmitGate, onFailure: (cause: unknown) => Effect.Effect<void>) => Effect.fn("Acceptance.runLane")(function* (start: Observation) {
  const initial = initialProgress(start)
  const state = yield* Ref.make(initial)
  const deadline = Duration.seconds(input.configuration.deadlineSeconds)
  const outcome = yield* pipe(interact(input, state, 0, gate), Effect.timeout(deadline), Effect.tapError(onFailure), Effect.result)
  const progress = yield* Ref.get(state)

  return LaneOutcome.make({ lane: gate.lane, scenario: input.scenario, progress, failure: failureOf(outcome) })
})

const inLane = (lane: Lane) => (id: string) => Array.contains(lane.inputs, id)

const laneScenario = (scenario: Scenario, lane: Lane) => {
  const inputs = Array.filter(scenario.inputs, flow(Struct.get("id"), inLane(lane)))

  return Scenario.make({ ...scenario, goal: lane.goal, required: lane.inputs, inputs })
}

const ofLane = (lane: Lane) => (entry: ReplayTraceEntry) => Option.contains(entry.lane, lane.id)

const laneRecording = (lane: Lane) => (recording: ReplayScenario) => {
  const candidates = Array.filter(recording.candidates, flow(Struct.get("inputCase"), inLane(lane)))
  const trace = Array.filter(recording.trace, ofLane(lane))

  return ReplayScenario.make({ scenario: recording.scenario, candidates, trace })
}

const laneInput = (input: ScenarioInput, lane: Lane) => ScenarioInput.make({
  ...input,
  scenario: laneScenario(input.scenario, lane),
  artifacts: join(input.artifacts, lane.id),
  replay: Option.map(input.replay, laneRecording(lane)),
})

/** A lane beyond the first opens its own isolated browser context with the actor's own session before it interacts. */
const openLane = Effect.fn("Acceptance.openLane")(function* (input: ScenarioInput) {
  const surface = yield* BrowserSurface
  const runtime = yield* FixtureRuntime
  const token = yield* runtime.session(input.fixture)

  if (Option.isSome(token)) yield* surface.authenticate(token.value)

  const startPath = join(input.artifacts, "start.png")

  return yield* surface.observe(false, startPath)
})

const failedLane = (input: ScenarioInput, gate: SubmitGate, start: Observation, onFailure: (cause: unknown) => Effect.Effect<void>) => Effect.fn("Acceptance.failedLane")(function* (error: AcceptanceError) {
  yield* onFailure(error)

  const reason = failureText(error)
  const failure = Option.some(reason)
  const progress = initialProgress(start)

  return LaneOutcome.make({ lane: gate.lane, scenario: input.scenario, progress, failure })
})

const competingLane = (input: ScenarioInput, start: Observation, starter: Starter, barrier: Barrier) => (lane: Lane, index: number) => {
  const scoped = laneInput(input, lane)
  const requests = Option.some(barrier.arrive(lane.id))
  const gate: SubmitGate = { lane: Option.some(lane.id), before: starter, requests }
  const onFailure = barrier.breakWith(lane.id)
  const run = runLane(scoped, gate, onFailure)
  const browser = browserLayer(scoped.target)
  const first = Equal.equals(index, 0)

  const isolated = pipe(
    openLane(scoped),
    Effect.flatMap(run),
    Effect.provide(browser),
    Effect.catch(failedLane(scoped, gate, start, onFailure)),
  )

  return first ? run(start) : isolated
}

const soleInteraction = Effect.fn("Acceptance.soleInteraction")(function* (input: ScenarioInput, start: Observation, starter: Starter) {
  const gate: SubmitGate = { lane: Option.none(), before: starter, requests: unheldRequests }
  const outcome = yield* runLane(input, gate, ignoreFailure)(start)

  return Interactions.make({ lanes: [outcome], barrier: Option.none() })
})

/** Runs every lane concurrently in its own browser context because the competing submissions must be in flight together at the declared barrier. */
const concurrentInteraction = (input: ScenarioInput, start: Observation, starter: Starter) => Effect.fn("Acceptance.concurrentInteraction")(function* (concurrency: Concurrency) {
  const barrier = yield* makeBarrier(concurrency)
  const lanes = Array.map(concurrency.lanes, competingLane(input, start, starter, barrier))
  const outcomes = yield* Effect.all(lanes, { concurrency: "unbounded" })
  const record = yield* barrier.record

  return Interactions.make({ lanes: outcomes, barrier: Option.some(record) })
})

const interactionsOf = (input: ScenarioInput, start: Observation, starter: Starter) => Option.match(input.scenario.concurrency, {
  onNone: () => soleInteraction(input, start, starter),
  onSome: concurrentInteraction(input, start, starter),
})

const bySubmittedAt = Order.mapInput(Order.String, Struct.get<Submission, "at">("at"))
const byTracedAt = Order.mapInput(Order.String, Struct.get<TraceEntry, "at">("at"))

/** Joins lane progress into the scenario's evidence; the first lane's view and reload state stand for the context that captures the closing lists. */
const mergedProgress = (start: Observation, lanes: ReadonlyArray<LaneOutcome>) => {
  const progresses = Array.map(lanes, Struct.get("progress"))
  const fallback = initialProgress(start)
  const first = pipe(progresses, Array.head, Option.getOrElse(Function.constant(fallback)))

  return Progress.make({
    view: first.view,
    submissions: pipe(progresses, Array.flatMap(Struct.get("submissions")), Array.sort(bySubmittedAt)),
    candidates: Array.flatMap(progresses, Struct.get("candidates")),
    probes: Array.flatMap(progresses, Struct.get("probes")),
    reloaded: first.reloaded,
    activeForm: Option.none(),
    trace: pipe(progresses, Array.flatMap(Struct.get("trace")), Array.sort(byTracedAt)),
    repeated: {},
  })
}

const laneComplete = (outcome: LaneOutcome) => isComplete(outcome.scenario, outcome.progress)

const laneLabel = (lane: Option.Option<string>) => (failure: string) => Option.match(lane, { onNone: Function.constant(failure), onSome: (name) => `lane ${name}: ${failure}` })

const laneFailure = (outcome: LaneOutcome) => Option.map(outcome.failure, laneLabel(outcome.lane))

const findAssessment = (assessments: ReadonlyArray<BoundAssessment>, reference: string) => {
  const missing = runnerFailure("catalog")(`Missing resolved assessment ${reference}`)

  return pipe(assessments, Array.findFirst(byReference(reference)), Effect.fromOption, Effect.mapError(Function.constant(missing)))
}

const submittedStep = (inputCase: string) => (entry: TraceEntry) => {
  const executed = entry.executed && Equal.equals(entry.action.kind, "submit")

  return executed && Option.contains(entry.action.inputCase, inputCase)
}

const shownAfter = (trace: ReadonlyArray<TraceEntry>, inputCase: string) => pipe(trace, Array.filter(submittedStep(inputCase)), Array.last, Option.flatMap(flow(Struct.get("observation"), Struct.get("screenshot"))))

const feedbackEvidence = (trace: ReadonlyArray<TraceEntry>) => (submission: Submission) => {
  const screenshot = shownAfter(trace, submission.inputCase)
  const shown = (feedback: string) => AssessmentEvidence.make({ inputCase: submission.inputCase, operation: submission.operation, status: submission.status, feedback, screenshot })

  return Option.map(submission.feedback, shown)
}

const assessedFrom = (assessment: BoundAssessment) => AssessedRequirement.make({
  reference: assessment.reference,
  revision: assessment.requirement.revision,
  approval: assessment.requirement.approval,
  rubric: assessment.rubric,
})

const failedAssessment = (assessed: AssessedRequirement, scenario: Scenario, evidence: ReadonlyArray<AssessmentEvidence>, references: ReadonlyArray<string>) => (error: AcceptanceError) =>
  unratedAssessment(assessed, scenario, evidence, references)("inconclusive", `the model assessment did not complete: ${error.message}`)

/** Rates the feedback the user was shown against the requirement's rubric with a real model; a replay never asks a model, so it stays blocked. */
const assessScenario = (input: ScenarioInput, progress: Progress, scenarioPath: string) => Effect.fn("Acceptance.assess")(function* (reference: string) {
  const assessment = yield* findAssessment(input.assessments, reference)
  const assessed = assessedFrom(assessment)
  const evidence = pipe(progress.submissions, Array.map(feedbackEvidence(progress.trace)), Array.getSomes)
  const shots = pipe(evidence, Array.map(Struct.get("screenshot")), Array.getSomes)
  const references = Array.prepend(shots, scenarioPath)
  const unrated = unratedAssessment(assessed, input.scenario, evidence, references)
  const replaying = Option.isSome(input.replay)

  if (Array.isReadonlyArrayEmpty(evidence)) return unrated("blocked", "no rendered operation feedback was captured for any submission, so there is nothing to review.")

  if (replaying) return unrated("blocked", "a model-free replay performs no model assessment; the retained exploration assessment is the latest review.")

  const model = yield* DecisionModel
  const request = AssessmentRequest.make({ requirement: assessment.requirement.text, rubric: assessment.rubric, evidence })
  const decided = yield* pipe(model.assess(request), Effect.result)

  return Result.match(decided, {
    onFailure: failedAssessment(assessed, input.scenario, evidence, references),
    onSuccess: ratedAssessment(assessed, input.scenario, evidence, references),
  })
})

const blockedAssessment = (assessments: ReadonlyArray<BoundAssessment>, scenario: Scenario, explanation: string, references: ReadonlyArray<string>) => Effect.fn("Acceptance.blockedAssessment")(function* (reference: string) {
  const assessment = yield* findAssessment(assessments, reference)
  const assessed = assessedFrom(assessment)

  return unratedAssessment(assessed, scenario, [], references)("blocked", explanation)
})

const proceed = (input: ScenarioInput) => Effect.fn("Acceptance.proceed")(function* (baseline: Baseline) {
  const unstarted = Option.none<WatchFiber>()
  const started = yield* Ref.make(unstarted)
  const starter = watchStarter(input.fixture, input.scenario.watch, started)
  const interactions = yield* interactionsOf(input, baseline.start, starter)
  const progress = mergedProgress(baseline.start, interactions.lanes)
  const watching = yield* pipe(joinWatch(started), Effect.result)
  const watched = pipe(watching, Result.getSuccess, Option.flatten)
  const closingResult = yield* pipe(closingEvidence(input, progress), Effect.result)
  const closing = closingOf(closingResult)
  const closingFailure = failureOf(closingResult)
  const watchLabel = laneLabel(watchLane)
  const watchFailure = pipe(watching, failureOf, Option.map(watchLabel))
  const laneFailures = pipe(interactions.lanes, Array.map(laneFailure), Array.getSomes)
  const interruptions = [...laneFailures, ...Array.getSomes([watchFailure, closingFailure])]
  const joined = Array.join(interruptions, "; ")
  const interruption = Array.isReadonlyArrayNonEmpty(interruptions) ? Option.some(joined) : Option.none<string>()
  const evidenceFailure = Option.orElse(watchFailure, Function.constant(closingFailure))
  const scenarioPath = join(input.artifacts, "scenario.json")
  const traceObservations = Array.map(progress.trace, Struct.get("observation"))
  const beforeShots = screenshotsOf(baseline.before)
  const traceShots = pipe(traceObservations, screenshotsOf, Array.dedupe)
  const afterShots = screenshotsOf(closing.after)
  const shots = pipe(beforeShots, Array.appendAll(traceShots), Array.appendAll(afterShots))
  const evidence = Array.prepend(shots, scenarioPath)
  const watchRecords = pipe(watched, Option.map(Struct.get("records")), Option.getOrElse(Array.empty<ProbeRecord>))
  const probes = pipe(baseline.probes, Array.appendAll(progress.probes), Array.appendAll(watchRecords), Array.appendAll(closing.probes))
  const watch = Option.map(watched, Struct.get("record"))

  const context = EvaluationContext.make({
    scenario: input.scenario,
    fixture: input.fixture,
    candidates: progress.candidates,
    submissions: progress.submissions,
    before: baseline.before,
    after: closing.after,
    probes,
    directProbe: closing.directProbe,
    barrier: interactions.barrier,
    watch,
    interruption,
    evidence,
  })

  const results = yield* Option.match(evidenceFailure, {
    onNone: () => Effect.forEach(input.scenario.requirements, evaluateRequirement(input.requirements, context)),
    onSome: (failure) => Effect.forEach(input.scenario.requirements, unevaluated(input.requirements, input.scenario, "inconclusive", `Closing evidence unavailable: ${failure}`, evidence)),
  })

  const assessments = yield* Effect.forEach(input.scenario.assessments, assessScenario(input, progress, scenarioPath))

  return ScenarioRun.make({
    scenario: input.scenario,
    fixture: input.fixture,
    candidates: progress.candidates,
    submissions: progress.submissions,
    before: baseline.before,
    after: closing.after,
    probes,
    directProbe: closing.directProbe,
    barrier: interactions.barrier,
    watch,
    trace: progress.trace,
    results,
    assessments,
    interruption,
    actionCompletion: Array.every(interactions.lanes, laneComplete),
  })
})

const blockedRun = (requirements: ReadonlyArray<BoundRequirement>, assessments: ReadonlyArray<BoundAssessment>, scenario: Scenario, fixture: PreparedFixture, artifacts: string) =>
  Effect.fn("Acceptance.blockedRun")(function* (error: AcceptanceError) {
    const message = String(error)
    const explanation = `Scenario prerequisite failed: ${message}`
    const results = yield* Effect.forEach(scenario.requirements, unevaluated(requirements, scenario, "blocked", explanation, [artifacts]))
    const assessed = yield* Effect.forEach(scenario.assessments, blockedAssessment(assessments, scenario, explanation, [artifacts]))

    return ScenarioRun.make({
      scenario,
      fixture,
      candidates: [],
      submissions: [],
      before: [],
      after: [],
      probes: [],
      directProbe: Option.none(),
      barrier: Option.none(),
      watch: Option.none(),
      trace: [],
      results,
      assessments: assessed,
      interruption: Option.some(message),
      actionCompletion: false,
    })
  })

const executeScenario = (input: ScenarioInput) => {
  const baseline = prerequisites(input)

  return Effect.matchEffect(baseline, {
    onFailure: blockedRun(input.requirements, input.assessments, input.scenario, input.fixture, input.artifacts),
    onSuccess: proceed(input),
  })
}

const unpreparedFixture = (scenario: Scenario, actor: Actor, revision: string) =>
  PreparedFixture.make({ binding: scenario.fixture, revision, url: "", actor: actor.binding, facts: {}, tracked: [] })

const byScenarioId = (id: string) => (run: ScenarioRun) => Equal.equals(run.scenario.id, id)

const byResultRequirement = (id: string) => (result: RequirementResult) => Equal.equals(result.requirement, id)

const resultFor = (id: string) => (run: ScenarioRun) => Array.findFirst(run.results, byResultRequirement(id))

const missingCoverage = Function.constant<"missing">("missing")

const coverageEntry = (scenarios: ReadonlyArray<ScenarioRun>, scenario: Scenario) => (requirement: BoundRequirement) => {
  const result = pipe(scenarios, Array.findFirst(byScenarioId(scenario.id)), Option.flatMap(resultFor(requirement.reference)), Option.map(Struct.get("status")), Option.getOrElse(missingCoverage))

  return Coverage.make({ requirement: requirement.reference, scenario: scenario.id, result, text: requirement.text, category: requirement.category })
}

const resolveRequirement = (requirements: ReadonlyArray<BoundRequirement>) => (reference: string) => Array.findFirst(requirements, byReference(reference))

const scenarioCoverage = (requirements: ReadonlyArray<BoundRequirement>, scenarios: ReadonlyArray<ScenarioRun>) => (scenario: Scenario) =>
  pipe(scenario.requirements, Array.map(resolveRequirement(requirements)), Array.getSomes, Array.map(coverageEntry(scenarios, scenario)))

const coverageOf = (validated: ValidatedCatalog, scenarios: ReadonlyArray<ScenarioRun>) => Array.flatMap(validated.catalog.scenarios, scenarioCoverage(validated.requirements, scenarios))

const sameSpecification = (replay: Replay, build: BuildIdentity) => {
  const sameCatalog = Equal.equals(replay.build.catalogHash, build.catalogHash)
  const sameContracts = Equal.equals(replay.build.nativeContractsHash, build.nativeContractsHash)

  return sameCatalog && sameContracts
}

const sameRecordedScenario = (scenario: Scenario) => (item: ReplayScenario) => {
  const sameId = Equal.equals(item.scenario.id, scenario.id)

  return sameId && Equal.equals(item.scenario.revision, scenario.revision)
}

const coveredOnce = (replay: Replay) => (scenario: Scenario) => {
  const matches = Array.filter(replay.scenarios, sameRecordedScenario(scenario))

  return Equal.equals(matches.length, 1)
}

const hasExactCoverage = (replay: Replay, catalog: Catalog) => {
  const sameCount = Equal.equals(replay.scenarios.length, catalog.scenarios.length)

  return sameCount && Array.every(catalog.scenarios, coveredOnce(replay))
}

const requireFormat = (format: string) => (replay: Replay) => {
  const matches = Equal.equals(replay.format, format)
  const mismatch = runnerFailure("replay")(`Replay format ${replay.format} is not ${format}`)

  return matches ? Effect.succeed(replay) : Effect.fail(mismatch)
}

const fileEntry = (file: typeof FileHashSchema.Type) => Tuple.make(file.path, file.sha256)

const fileDigests = (files: ReadonlyArray<typeof FileHashSchema.Type>) => pipe(files, Array.map(fileEntry), Record.fromEntries)

const differsBetween = (before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>) => (path: string) => {
  const recorded = Record.get(before, path)
  const current = Record.get(after, path)

  return !Equal.equals(recorded, current)
}

/** Every hashed file added, removed, or changed since the recorded build because only declared presentation sources may differ in repair mode. */
const changedFiles = (recorded: ReadonlyArray<typeof FileHashSchema.Type>, current: ReadonlyArray<typeof FileHashSchema.Type>) => {
  const before = fileDigests(recorded)
  const after = fileDigests(current)
  const beforePaths = Record.keys(before)
  const afterPaths = Record.keys(after)
  const paths = pipe(beforePaths, Array.appendAll(afterPaths), Array.dedupe, Array.sort(Order.String))

  return Array.filter(paths, differsBetween(before, after))
}

const identityKey = (identity: SurfaceIdentity) => `${identity.id}@${identity.semantics}`

const identityKeys = (identities: ReadonlyArray<SurfaceIdentity>) => pipe(identities, Array.map(identityKey), Array.sort(Order.String), Array.join(","))

/** What a replay pass may accept: whether presentation-only changes are allowed, the declared presentation files, and the current binding identities. */
class ReplayAllowance extends Schema.Class<ReplayAllowance>("ReplayAllowance")({
  presentationAllowed: Schema.Boolean,
  presentation: ChangedFilesSchema,
  surfaces: SurfaceIdentitiesSchema,
}) {}

const staleReplay = runnerFailure("replay")("Replay is stale against application, catalog, evaluator, browser bindings, or native contracts; only --repair-locators may accept a presentation-only change")

const staleSpecification = runnerFailure("replay")("Replay is stale against the catalog or native contracts; no locator repair can accept a changed specification")

/**
 * Accepts an unchanged build, or in repair mode a build whose only changed files are declared presentation sources while the catalog,
 * native contracts, and custom binding semantics are identical, because a repair may change locators but never what is exercised.
 */
const validateReplay = (build: BuildIdentity, catalog: Catalog, allowance: ReplayAllowance) =>
  Effect.fn("Acceptance.validateReplay")(function* (replay: Replay) {
    if (!sameSpecification(replay, build)) return yield* staleSpecification

    if (!hasExactCoverage(replay, catalog)) return yield* runnerFailure("replay")("Replay lacks exact scenario coverage")

    const unchanged = Equal.equals(replay.build.sha256, build.sha256)
    const unchangedReplay = CheckedReplay.make({ replay, presentation: [] })

    if (unchanged) return unchangedReplay

    if (!allowance.presentationAllowed) return yield* staleReplay

    const changed = changedFiles(replay.build.files, build.files)
    const undeclared = Array.filter(changed, Predicate.not(amongst(allowance.presentation)))
    const undeclaredList = Array.join(undeclared, ", ")
    const recorded = Option.map(replay.surfaces, identityKeys)
    const current = identityKeys(allowance.surfaces)
    const sameSemantics = Option.contains(recorded, current)

    if (Array.isReadonlyArrayNonEmpty(undeclared)) return yield* runnerFailure("replay")(`Replay is stale: files outside the declared presentation sources changed (${undeclaredList}); locator repair accepts presentation-only changes`)

    if (!sameSemantics) return yield* runnerFailure("replay")("Replay is stale: the custom binding semantics changed or were not recorded; locator repair requires identical binding semantics")

    return CheckedReplay.make({ replay, presentation: changed })
  })

const unfinished = Option.none<string>()

const undecided = Option.none<typeof SliceStatusSchema.Type>()

const replayFailure = flow(String, runnerFailure("replay"))

const loadReplay = (format: string, build: BuildIdentity, catalog: Catalog, allowance: ReplayAllowance) =>
  Effect.fn("Acceptance.loadReplay")(function* (path: string) {
    const evidence = yield* RunEvidence
    const content = yield* evidence.read(path)
    const replay = yield* pipe(content, Schema.decodeUnknownEffect(Replay), Effect.mapError(replayFailure), Effect.flatMap(requireFormat(format)))

    return yield* validateReplay(build, catalog, allowance)(replay)
  })

const recordedFor = (scenario: Scenario) => (item: ReplayScenario) => Equal.equals(item.scenario.id, scenario.id)

const byRecordedScenario = (scenario: Scenario) => (replay: Replay) => Array.findFirst(replay.scenarios, recordedFor(scenario))

const isPassing = (result: RequirementResult) => Equal.equals(result.status, "pass")

const scenarioPassed = (run: ScenarioRun) => run.actionCompletion && Array.every(run.results, isPassing)

const verifierClean = (report: VerifierHeadline) => {
  const noFalseAcceptance = Equal.equals(report.summary.falseAcceptance, 0)
  const noFalseRejection = Equal.equals(report.summary.falseRejection, 0)
  const noUnexpected = Equal.equals(report.summary.unexpectedStatuses, 0)
  const noFalseVerdicts = noFalseAcceptance && noFalseRejection

  return noFalseVerdicts && noUnexpected
}

const describeResult = (result: RequirementResult) => `${result.requirement}=${result.status}`

const describeAssessment = (assessment: AssessmentRun) => `${assessment.result.requirement}=${assessment.result.status} (${assessment.result.basis})`

const verifierFailure = flow(String, runnerFailure("verifier"))

type Secrets = Ref.Ref<ReadonlyArray<Secret>>

/** The browser route decides where the browser points because fault runs interpose a proxy while probes keep the owned upstream. */
type BrowserRoute = (fixture: PreparedFixture) => Effect.Effect<string, AcceptanceError, Scope.Scope | FixtureRuntime>

const directRoute: BrowserRoute = flow(Struct.get("url"), Effect.succeed)

class ScenarioPlan extends Schema.Class<ScenarioPlan>("ScenarioPlan")({
  catalog: Catalog,
  requirements: BoundRequirementsSchema,
  assessments: BoundAssessmentsSchema,
  scenario: Scenario,
  artifacts: Schema.String,
  configuration: RunConfiguration,
  seed: Schema.Int,
  replay: OptionalReplayScenarioSchema,
}) {}

const recordInjection = (injections: Ref.Ref<ReadonlyArray<string>>) => (injection: string) => Ref.update(injections, Array.append(injection))

const faultRoute = (fault: Fault, injections: Ref.Ref<ReadonlyArray<string>>): BrowserRoute => Effect.fn("Acceptance.faultRoute")(function* (fixture: PreparedFixture) {
  const runtime = yield* FixtureRuntime
  const context: FaultContext = { fixture, upstream: fixture.url, runtime, call, record: recordInjection(injections) }
  const behavior = yield* fault.behavior(context)
  const proxy = yield* serveFaultProxy(context.upstream, behavior)

  return proxy.url
})

/** Plays one scenario through the normal runner path and retains its scenario.json because every mode must judge identical evidence. */
const playScenario = (definition: AcceptanceDefinition, surfaces: ReadonlyArray<SurfaceBinding>, route: BrowserRoute, secrets: Secrets) => Effect.fn("Acceptance.playScenario")(function* (plan: ScenarioPlan) {
  const evidence = yield* RunEvidence
  const fixtures = yield* FixtureRuntime
  const { catalog, requirements, assessments, scenario, artifacts, configuration } = plan
  const actor = yield* findById(catalog.actors, "actor", scenario.actor)
  const unprepared = unpreparedFixture(scenario, actor, fixtures.revision)
  const apiKey = Option.getOrElse(configuration.apiKey, Function.constant(emptyKey))
  const jev = pipe(JevConfiguration.make({ apiKey, model: configuration.model }), jevLayer)

  const execution = Effect.gen(function* () {
    const fixture = yield* fixtures.prepare(scenario, actor.binding, artifacts)
    const retained = yield* fixtures.secrets(fixture)

    yield* Ref.update(secrets, Array.appendAll(retained))

    const url = yield* route(fixture)
    const surface = surfaceFor(surfaces, scenario.id)
    const target = BrowserTarget.make({ url, artifacts, surface })
    const browser = browserLayer(target)
    const observations = Array.map(scenario.observations, definition.observationOperation)

    const input = ScenarioInput.make({
      catalog,
      requirements,
      assessments,
      scenario,
      actor,
      fixture,
      target,
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

  const run = yield* pipe(execution, Effect.scoped, Effect.catch(blockedRun(requirements, assessments, scenario, unprepared, artifacts)))
  const scenarioPath = join(artifacts, "scenario.json")

  yield* evidence.save(scenarioPath, ScenarioRun, run)

  return run
})

const validatedCatalog = Effect.fn("Acceptance.validatedCatalog")(function* (definition: AcceptanceDefinition) {
  const fixtures = yield* FixtureRuntime

  const bindings = CatalogBindings.make({
    evaluators: definition.evaluators,
    fixtures: fixtures.bindings,
    actors: fixtures.actors,
    facts: fixtures.facts,
    probes: fixtures.probes,
    catalogs: definition.catalogs,
  })

  return yield* validateCatalog(definition.catalog, bindings, definition.application)
})

const sourceIn = (output: string) => (path: string) => replaySource(output, path)

const coverageLineage = (entry: Coverage) => LineageResult.make({ scope: entry.scenario, requirement: entry.requirement, status: entry.result })

const lineageBuild = (build: BuildIdentity) => LineageBuild.make({ sha256: build.sha256, catalogHash: build.catalogHash, nativeContractsHash: build.nativeContractsHash, importedCatalogs: build.importedCatalogs })

/** Governance findings fail the run and are logged by path because both credentials and unrelated protected records must never be retained or derived. */
const reportLeaks = (leaks: ReadonlyArray<string>) => {
  const paths = Array.join(leaks, ", ")
  const logged = Effect.logError(`Evidence governance findings (credential value or unrelated protected record): ${paths}`)

  return Array.isReadonlyArrayEmpty(leaks) ? Effect.void : logged
}

/** Saves the final report for the given findings and returns its lineage facts because only the mode knows its report and status. */
type Finish = (leaks: ReadonlyArray<string>) => Effect.Effect<LineageFacts, AcceptanceError, RunEvidence>

/** Writes the lineage manifest because the ownership marker stays with the mode that claimed the directory. */
type Recorder = (facts: LineageFacts, sealed: Seal) => Effect.Effect<unknown, AcceptanceError>

const findingsOf = Effect.fn("Acceptance.findings")(function* (output: string, policy: EvidencePolicy, secrets: ReadonlyArray<Secret>) {
  const evidence = yield* RunEvidence
  const retained = yield* evidence.scan(output, secrets)
  const sealed = yield* seal(output, policy, secrets)
  const derived = sealFindings(sealed)
  const leaks = pipe(retained, Array.appendAll(derived), Array.dedupe)

  return Tuple.make(leaks, sealed)
})

/**
 * Seals the run, saves the final report, records lineage, and then re-verifies every final retained byte and derived
 * view with the in-memory secrets, because the final report and lineage manifest exist only after the first seal.
 * The verification seal is what lineage keeps; a late finding rewrites the report as not passed.
 */
const sealRun = Effect.fn("Acceptance.sealRun")(function* (output: string, policy: EvidencePolicy, secrets: ReadonlyArray<Secret>, finish: Finish, record: Recorder) {
  const [leaks, first] = yield* findingsOf(output, policy, secrets)
  const facts = yield* finish(leaks)

  yield* record(facts, first)

  const [late, verification] = yield* findingsOf(output, policy, secrets)
  const verified = Array.isReadonlyArrayEmpty(late)
  const combined = pipe(leaks, Array.appendAll(late), Array.dedupe)
  const finalFacts = yield* (verified ? Effect.succeed(facts) : finish(combined))

  yield* record(finalFacts, verification)

  // The terminal scan reads the rewritten lineage too because nothing may be written after the last secret scan.
  const evidence = yield* RunEvidence
  const terminal = yield* evidence.scan(output, secrets)
  const all = pipe(combined, Array.appendAll(terminal), Array.dedupe)

  yield* reportLeaks(all)

  return all
})

const validatedSurfaces = Effect.fn("Acceptance.validatedSurfaces")(function* (definition: AcceptanceDefinition, catalog: Catalog) {
  const surfaces = yield* validateSurfaces(definition.surfaces, catalog.scenarios, definition.application)
  const identities = yield* Effect.forEach(surfaces, surfaceIdentity)

  return Tuple.make(surfaces, identities)
})

const faultNamed = (id: string) => (fault: Fault) => Equal.equals(fault.declaration.id, id)

const unknownFault = (id: string) => runnerFailure("configuration")(`Unknown fault ${id}; use a declared fault id`)

const declaredFault = (definition: AcceptanceDefinition) => (id: string) => {
  const unknown = unknownFault(id)

  return pipe(definition.faults, Array.findFirst(faultNamed(id)), Effect.fromOption, Effect.mapError(Function.constant(unknown)))
}

/** Routes only the fault's own scenario through its proxy because every other scenario of a replay must keep the owned application. */
const routeFor = (fault: Option.Option<Fault>, injections: Ref.Ref<ReadonlyArray<string>>) => (scenario: Scenario): BrowserRoute => {
  const scoped = Option.filter(fault, faultScenario(scenario))

  return Option.match(scoped, { onNone: Function.constant(directRoute), onSome: routedThrough(injections) })
}

const faultScenario = (scenario: Scenario) => (fault: Fault) => Equal.equals(fault.declaration.scenario, scenario.id)

const routedThrough = (injections: Ref.Ref<ReadonlyArray<string>>) => (fault: Fault) => faultRoute(fault, injections)

const isRepaired = (entry: TraceEntry) => Option.isSome(entry.repair)

const repairsIn = (scenarios: ReadonlyArray<ScenarioRun>) => pipe(scenarios, Array.flatMap(Struct.get("trace")), Array.countBy(isRepaired))

const controlOf = (injections: ReadonlyArray<string>) => (declared: Fault) => ReplayControl.make({ fault: declared.declaration, injections })

const strictInterruption = (scenario: string) => (interruption: string) => StrictInterruption.make({ scenario, interruption })

const interruptionOf = (run: ScenarioRun) => Option.map(run.interruption, strictInterruption(run.scenario.id))

/** One pass's outcome because a repair run reports its preserved strict attempt next to its own result. */
class PassOutcome extends Schema.Class<PassOutcome>("PassOutcome")({
  passed: Schema.Boolean,
  runPath: Schema.String,
  scenarios: ScenarioRunsSchema,
}) {}

const describeMode = (exploring: boolean, repairing: boolean): typeof RunModeSchema.Type => {
  if (exploring) return "real-jev-exploration"

  return repairing ? "repaired-replay" : "recorded-replay"
}

const kindOfMode = (mode: typeof RunModeSchema.Type) => {
  if (Equal.equals(mode, "real-jev-exploration")) return "exploration"

  return Equal.equals(mode, "repaired-replay") ? "repaired-replay" : "replay"
}

const withRepairs = (scenarios: ReadonlyArray<ScenarioRun>) => (summary: RepairSummary) => RepairSummary.make({ ...summary, repaired: repairsIn(scenarios) })

const lineageRepair = (presentation: ReadonlyArray<string>) => (summary: RepairSummary) => LineageRepair.make({ strictAttempt: summary.strictAttempt, strictStatus: summary.strictStatus, repaired: summary.repaired, presentation })

/**
 * One complete run into one fresh output: exploration, strict replay, the strict attempt of a repair, or the repair pass itself.
 * `presentationAllowed` accepts a presentation-only build change (repair mode only); `strictAttempt` links a repair pass to its strict attempt.
 */
const runPass = Effect.fn("Acceptance.runPass")(function* (definition: AcceptanceDefinition, configuration: RunConfiguration, presentationAllowed: boolean, strictAttempt: Option.Option<RepairSummary>) {
  const evidence = yield* RunEvidence
  const fixtures = yield* FixtureRuntime
  const validated = yield* validatedCatalog(definition)
  const { catalog, requirements, assessments } = validated
  const [surfaces, identities] = yield* validatedSurfaces(definition, catalog)
  const fault = yield* pipe(configuration.fault, Option.map(declaredFault(definition)), Effect.transposeOption)
  const output = yield* evidence.directory(configuration.output)
  const runPath = join(output, "run.json")
  const alreadyExists = yield* evidence.exists(runPath)

  if (alreadyExists) {
    return yield* runnerFailure("evidence")("Output already contains run.json; choose a fresh directory to preserve previous evidence")
  }

  const build = yield* evidence.identify(definition.catalog, definition.catalogs)
  const presentation = pipe(surfaces, Array.flatMap(Struct.get("presentation")), Array.dedupe)
  const allowance = ReplayAllowance.make({ presentationAllowed, presentation, surfaces: identities })
  const startedAt = yield* now
  const pendingReplay = Option.map(configuration.replay, loadReplay(definition.format, build, catalog, allowance))
  const checked = yield* Effect.transposeOption(pendingReplay)
  const replay = Option.map(checked, Struct.get("replay"))
  const changed = pipe(checked, Option.map(Struct.get("presentation")), Option.filter(Array.isReadonlyArrayNonEmpty))
  const exploring = Option.isNone(replay)
  const missingKey = exploring && Option.isNone(configuration.apiKey)

  if (missingKey) {
    return yield* runnerFailure("decision")("TYPESAFE_API_KEY is required for real Jev exploration (never a mock fallback)")
  }

  const mode = describeMode(exploring, configuration.repairLocators)
  const kind = kindOfMode(mode)
  const marker = yield* claimOwnership(output, definition.policy, kind, startedAt)
  const pendingSource = Option.map(configuration.replay, sourceIn(output))
  const source = yield* Effect.transposeOption(pendingSource)
  const verifier = yield* definition.verifier
  const headline = yield* pipe(verifier, Schema.decodeUnknownEffect(VerifierHeadline), Effect.mapError(verifierFailure))
  const verifierPath = join(output, "verifier.json")

  yield* evidence.save(verifierPath, Schema.Unknown, verifier)

  const ledger = Ledger.make({ advanced: definition.advanced, closed: [], unexercised: definition.unexercised })

  const retainedConfiguration = RetainedConfiguration.make({
    model: configuration.model,
    minimumConfidence: configuration.minimumConfidence,
    maxActions: configuration.maxActions,
    deadlineSeconds: configuration.deadlineSeconds,
    seed: configuration.seed,
    browser: browserConfiguration,
    mode,
    sourceReplay: configuration.replay,
  })

  const runs = yield* Ref.make<ReadonlyArray<ScenarioRun>>([])
  const initialSecrets = Option.toArray(configuration.apiKey)
  const secrets = yield* Ref.make<ReadonlyArray<Secret>>(initialSecrets)
  const injections = yield* Ref.make<ReadonlyArray<string>>([])
  const route = routeFor(fault, injections)

  const report = Effect.fn("Acceptance.passReport")(function* (scenarios: ReadonlyArray<ScenarioRun>, evidenceLeaks: ReadonlyArray<string>, finishedAt: Option.Option<string>, sliceStatus: Option.Option<"pass" | "not-passed">) {
    const coverage = coverageOf(validated, scenarios)
    const injected = yield* Ref.get(injections)
    const control = Option.map(fault, controlOf(injected))
    const repair = Option.map(strictAttempt, withRepairs(scenarios))

    return RunReport.make({
      format: definition.format,
      startedAt,
      catalog,
      build,
      surfaces: identities,
      fixtureRevision: fixtures.revision,
      configuration: retainedConfiguration,
      presentationChange: changed,
      repair,
      control,
      scenarios,
      verifier,
      fullSystemCompletion: false,
      ledger,
      coverage,
      evidenceLeaks,
      finishedAt,
      sliceStatus,
    })
  })

  const initialReport = yield* report([], [], unfinished, undecided)

  yield* evidence.save(runPath, RunReport, initialReport)

  const runScenario = Effect.fn("Acceptance.runScenario")(function* (scenario: Scenario, index: number) {
    const artifactsName = encodeURIComponent(scenario.id)
    const artifactsPath = join(output, artifactsName)
    const artifacts = yield* evidence.directory(artifactsPath)
    const recorded = Option.flatMap(replay, byRecordedScenario(scenario))
    const seed = configuration.seed + index
    const plan = ScenarioPlan.make({ catalog, requirements, assessments, scenario, artifacts, configuration, seed, replay: recorded })
    const run = yield* playScenario(definition, surfaces, route(scenario), secrets)(plan)
    const scenarios = yield* Ref.updateAndGet(runs, Array.append(run))
    const progressReport = yield* report(scenarios, [], unfinished, undecided)

    yield* evidence.save(runPath, RunReport, progressReport)

    const summary = pipe(run.results, Array.map(describeResult), Array.join(", "))
    const assessed = pipe(run.assessments, Array.map(describeAssessment), Array.join(", "))
    const assessedText = Array.isReadonlyArrayNonEmpty(run.assessments) ? `; non-gating ${assessed}` : ""

    yield* Effect.logInfo(`${scenario.id}: actionCompletion=${run.actionCompletion}; ${summary}${assessedText}`)
  })

  yield* Effect.forEach(catalog.scenarios, runScenario, { discard: true })

  const scenarios = yield* Ref.get(runs)
  const retainedSecrets = yield* Ref.get(secrets)
  const complete = Equal.equals(scenarios.length, catalog.scenarios.length)
  const allPassed = Array.every(scenarios, scenarioPassed)
  const scenariosPassed = complete && allPassed
  const qualified = scenariosPassed && verifierClean(headline)
  const finishedAt = yield* now
  const finishedAtOption = Option.some(finishedAt)
  const lineage = lineageBuild(build)
  const changedFiles = Option.getOrElse(changed, Array.empty<string>)

  const finish = Effect.fn("Acceptance.finishRun")(function* (leaks: ReadonlyArray<string>) {
    const sealed = Array.isReadonlyArrayEmpty(leaks)
    const sliceStatus = qualified && sealed ? "pass" : "not-passed"
    const sliceStatusOption = Option.some<typeof SliceStatusSchema.Type>(sliceStatus)
    const finished = yield* report(scenarios, leaks, finishedAtOption, sliceStatusOption)

    yield* evidence.save(runPath, RunReport, finished)

    const results = pipe(finished.coverage, Array.map(coverageLineage))

    return LineageFacts.make({
      finishedAt,
      status: sliceStatus,
      build: lineage,
      catalog: catalog.id,
      catalogRevision: catalog.revision,
      imports: catalog.imports,
      results,
      replaySource: source,
      repair: Option.map(finished.repair, lineageRepair(changedFiles)),
    })
  })

  const record = (facts: LineageFacts, sealed: Seal) => recordLineage(output, marker, facts, sealed)
  const leaks = yield* sealRun(output, definition.policy, retainedSecrets, finish, record)
  const passed = qualified && Array.isReadonlyArrayEmpty(leaks)
  const sliceStatus = passed ? "pass" : "not-passed"
  const open = pipe(definition.advanced, Array.appendAll(definition.unexercised), Array.join(", "))

  yield* Effect.logInfo(`${definition.title} (${definition.name}) ${mode} slice ${sliceStatus}; evidence ${runPath}; ledger obligations remain open: ${open}`)

  return PassOutcome.make({ passed, runPath, scenarios })
})

const repairWithoutReplay = runnerFailure("configuration")("--repair-locators repairs a recorded run; pass --replay PATH/run.json")

const faultWithoutReplay = runnerFailure("configuration")("--fault routes a replay through a declared fault; fault explorations use --faults")

/**
 * Runs an exploration or strict replay, or, with --repair-locators, first a complete strict replay into `<output>-strict-attempt`
 * (preserved evidence of any locator failure) and then the repair pass into `<output>`, which links to that strict attempt.
 */
export const runAcceptance = Effect.fn("Acceptance.run")(function* (definition: AcceptanceDefinition, configuration: RunConfiguration) {
  const replaying = Option.isSome(configuration.replay)
  const faulted = Option.isSome(configuration.fault)
  const exploring = !replaying
  const unrepairable = configuration.repairLocators && exploring
  const unfaultable = faulted && exploring

  if (unrepairable) return yield* repairWithoutReplay

  if (unfaultable) return yield* faultWithoutReplay

  const strictOnly = Option.none<RepairSummary>()

  if (!configuration.repairLocators) {
    const outcome = yield* runPass(definition, configuration, false, strictOnly)

    return outcome.passed
  }

  const strictOutput = `${configuration.output}-strict-attempt`
  const strictConfiguration = RunConfiguration.make({ ...configuration, output: strictOutput, repairLocators: false })
  const strict = yield* runPass(definition, strictConfiguration, true, strictOnly)
  const strictInterruptions = pipe(strict.scenarios, Array.map(interruptionOf), Array.getSomes)
  const strictStatus = strict.passed ? "pass" : "not-passed"
  const strictAttempt = relative(configuration.output, strict.runPath)
  const summary = RepairSummary.make({ strictAttempt, strictStatus, strictInterruptions, repaired: 0 })
  const pending = Option.some(summary)
  const repaired = yield* runPass(definition, configuration, true, pending)

  return repaired.passed
})

const InterruptionCategorySchema = Schema.Literals(["none", "deadline", "action-limit", "no-progress", "stale-target", "unavailable-target", "cannot-proceed", "low-confidence", "prerequisite", "other"])

type InterruptionCategory = typeof InterruptionCategorySchema.Type

// Interruptions are categorized by the runner's and browser's fixed messages because those messages are the only retained cause.
const interruptionMarkers: ReadonlyArray<readonly [string, InterruptionCategory]> = [
  ["TimeoutError", "deadline"],
  ["Action limit", "action-limit"],
  ["Repeated action without completion", "no-progress"],
  ["Stale browser snapshot", "stale-target"],
  ["missing, ambiguous, hidden, or disabled", "unavailable-target"],
  ["cannot-proceed", "cannot-proceed"],
  ["cannot proceed", "cannot-proceed"],
  ["is below configured", "low-confidence"],
  ["Scenario prerequisite failed", "prerequisite"],
]

const markedBy = (text: string) => ([marker]: readonly [string, InterruptionCategory]) => text.includes(marker)

const markedCategory = ([, category]: readonly [string, InterruptionCategory]) => category

const categoryOf = (text: string) => pipe(interruptionMarkers, Array.findFirst(markedBy(text)), Option.map(markedCategory), Option.getOrElse(Function.constant<InterruptionCategory>("other")))

const interruptionCategory = (interruption: Option.Option<string>) => Option.match(interruption, { onNone: Function.constant<InterruptionCategory>("none"), onSome: categoryOf })

const FaultVerdictSchema = Schema.Literals(["detected", "missed", "truthful", "untruthful"])
const ResultsSchema = Schema.Array(RequirementResult)

/** One fault's live run because detection, uncertainty, action completion, and interruption must be reported separately. */
class FaultOutcome extends Schema.Class<FaultOutcome>("FaultOutcome")({
  fault: FaultDeclaration,
  artifacts: Schema.String,
  results: ResultsSchema,
  detected: Schema.Boolean,
  falseAcceptance: NamesSchema,
  undetectedUncertain: NamesSchema,
  passing: NamesSchema,
  anyCriterionPassed: Schema.Boolean,
  injections: NamesSchema,
  verdict: FaultVerdictSchema,
  interruption: OptionalFailureSchema,
  interruptionCategory: InterruptionCategorySchema,
  actionCompletion: Schema.Boolean,
  decisions: Schema.Int,
}) {}

class CleanOutcome extends Schema.Class<CleanOutcome>("CleanOutcome")({
  scenario: Schema.String,
  artifacts: Schema.String,
  results: ResultsSchema,
  passed: Schema.Boolean,
  interruption: OptionalFailureSchema,
  interruptionCategory: InterruptionCategorySchema,
  actionCompletion: Schema.Boolean,
  decisions: Schema.Int,
}) {}

class FaultsSummary extends Schema.Class<FaultsSummary>("FaultsSummary")({
  faults: Schema.Int,
  detected: Schema.Int,
  falseAcceptance: Schema.Int,
  falseRejection: Schema.Int,
  uncertain: Schema.Int,
  controls: Schema.Int,
  controlsTruthful: Schema.Int,
  cleanControls: Schema.Int,
  cleanPassed: Schema.Int,
}) {}

const FaultOutcomesSchema = Schema.Array(FaultOutcome)
const CleanOutcomesSchema = Schema.Array(CleanOutcome)
const OptionalSummarySchema = Schema.OptionFromOptionalKey(FaultsSummary)
const FaultsModeSchema = Schema.Literal("real-jev-faults")

class FaultsConfiguration extends Schema.Class<FaultsConfiguration>("FaultsConfiguration")({
  model: Schema.String,
  minimumConfidence: Schema.Number,
  maxActions: Schema.Int,
  deadlineSeconds: Schema.Int,
  seed: Schema.Int,
  browser: BrowserConfiguration,
  mode: FaultsModeSchema,
}) {}

const limitation = "Observed zero false acceptance on this finite set of injected faults is not a universal reliability claim."

class FaultsReport extends Schema.Class<FaultsReport>("FaultsReport")({
  format: Schema.NonEmptyString,
  application: Schema.String,
  startedAt: Schema.String,
  build: BuildIdentity,
  fixtureRevision: Schema.String,
  configuration: FaultsConfiguration,
  faults: FaultOutcomesSchema,
  clean: CleanOutcomesSchema,
  summary: OptionalSummarySchema,
  evidenceLeaks: LeaksSchema,
  limitation: Schema.String,
  finishedAt: OptionalFinishedSchema,
  status: OptionalSliceStatusSchema,
}) {}

const faultsFailure = runnerFailure("faults")

const statusOf = (results: ReadonlyArray<RequirementResult>) => (id: string) => pipe(results, Array.findFirst(byResultRequirement(id)), Option.map(Struct.get("status")))

const affectedWith = (results: ReadonlyArray<RequirementResult>, statuses: ReadonlyArray<string>) => (id: string) => pipe(id, statusOf(results), Option.exists(amongst(statuses)))

const decided = (entry: TraceEntry) => Option.isSome(entry.decision)

const decisionsOf = (run: ScenarioRun) => Array.countBy(run.trace, decided)

const isDefect = (fault: FaultDeclaration) => Equal.equals(fault.kind, "defective-implementation")

const faultOutcome = (fault: FaultDeclaration, artifacts: string, injections: ReadonlyArray<string>) => (run: ScenarioRun) => {
  const failing = Array.filter(fault.affected, affectedWith(run.results, ["fail"]))
  const falseAcceptance = Array.filter(fault.affected, affectedWith(run.results, ["pass"]))
  const uncertain = Array.filter(fault.affected, affectedWith(run.results, ["blocked", "inconclusive"]))
  const passing = pipe(run.results, Array.filter(isPassing), Array.map(Struct.get("requirement")))
  const detected = Equal.equals(failing.length, fault.affected.length)
  const interrupted = Option.isSome(run.interruption)
  const nothingPassed = Array.isReadonlyArrayEmpty(passing)
  const truthful = interrupted && nothingPassed
  const defectVerdict = detected ? "detected" : "missed"
  const controlVerdict = truthful ? "truthful" : "untruthful"

  return FaultOutcome.make({
    fault,
    artifacts,
    results: run.results,
    detected,
    falseAcceptance,
    undetectedUncertain: uncertain,
    passing,
    anyCriterionPassed: !nothingPassed,
    injections,
    verdict: isDefect(fault) ? defectVerdict : controlVerdict,
    interruption: run.interruption,
    interruptionCategory: interruptionCategory(run.interruption),
    actionCompletion: run.actionCompletion,
    decisions: decisionsOf(run),
  })
}

const cleanOutcome = (artifacts: string) => (run: ScenarioRun) => CleanOutcome.make({
  scenario: run.scenario.id,
  artifacts,
  results: run.results,
  passed: scenarioPassed(run),
  interruption: run.interruption,
  interruptionCategory: interruptionCategory(run.interruption),
  actionCompletion: run.actionCompletion,
  decisions: decisionsOf(run),
})

const isControl = Predicate.not(isDefect)

const byVerdict = (verdict: typeof FaultVerdictSchema.Type) => (outcome: FaultOutcome) => Equal.equals(outcome.verdict, verdict)

const outcomeIsDefect = (outcome: FaultOutcome) => isDefect(outcome.fault)

const outcomeIsControl = (outcome: FaultOutcome) => isControl(outcome.fault)

const falseAcceptanceCount = (outcome: FaultOutcome) => outcome.falseAcceptance.length

const uncertainCount = (outcome: FaultOutcome) => outcome.undetectedUncertain.length

const cleanPassed = Struct.get<CleanOutcome, "passed">("passed")

const summaryOf = (faults: ReadonlyArray<FaultOutcome>, clean: ReadonlyArray<CleanOutcome>) => {
  const defects = Array.filter(faults, outcomeIsDefect)
  const controls = Array.filter(faults, outcomeIsControl)
  const passedClean = Array.countBy(clean, cleanPassed)

  return FaultsSummary.make({
    faults: defects.length,
    detected: Array.countBy(defects, byVerdict("detected")),
    falseAcceptance: pipe(defects, Array.map(falseAcceptanceCount), Number.sumAll),
    falseRejection: clean.length - passedClean,
    uncertain: pipe(defects, Array.map(uncertainCount), Number.sumAll),
    controls: controls.length,
    controlsTruthful: Array.countBy(controls, byVerdict("truthful")),
    cleanControls: clean.length,
    cleanPassed: passedClean,
  })
}

const summaryPassed = (summary: FaultsSummary) => {
  const everyDefect = Equal.equals(summary.detected, summary.faults)
  const everyControl = Equal.equals(summary.controlsTruthful, summary.controls)
  const everyClean = Equal.equals(summary.cleanPassed, summary.cleanControls)
  const faultsHeld = everyDefect && everyControl

  return faultsHeld && everyClean
}

const reservedFaultIds = ["clean", "faults.json"]

const noRequirements = Array.empty<string>()

const problemWhen = (condition: boolean, problem: string) => condition ? Option.some(problem) : Option.none<string>()

const declarationProblems = (catalog: Catalog, declarations: ReadonlyArray<FaultDeclaration>) => (fault: FaultDeclaration) => {
  const scenario = Array.findFirst(catalog.scenarios, byId(fault.scenario))
  const judged = pipe(scenario, Option.map(Struct.get("requirements")), Option.getOrElse(Function.constant(noRequirements)))
  const unjudged = Array.filter(fault.affected, Predicate.not(amongst(judged)))
  const unjudgedList = Array.join(unjudged, ", ")
  const duplicates = Array.countBy(declarations, byId(fault.id))
  const duplicated = !Equal.equals(duplicates, 1)
  const reserved = Array.contains(reservedFaultIds, fault.id)
  const affecting = Array.isReadonlyArrayNonEmpty(fault.affected)
  const defect = isDefect(fault)
  const misdeclared = !Equal.equals(defect, affecting)
  const unknown = Option.isNone(scenario)
  const unjudging = Array.isReadonlyArrayNonEmpty(unjudged)

  const problems = [
    problemWhen(unknown, `${fault.id}: unknown scenario ${fault.scenario}`),
    problemWhen(unjudging, `${fault.id}: ${unjudgedList} not judged by ${fault.scenario}`),
    problemWhen(duplicated, `${fault.id}: duplicate fault id`),
    problemWhen(reserved, `${fault.id}: reserved evidence name`),
    problemWhen(misdeclared, `${fault.id}: defective implementations need affected requirements and execution controls need none`),
  ]

  return Array.getSomes(problems)
}

const validateFaults = Effect.fn("Acceptance.validateFaults")(function* (catalog: Catalog, faults: ReadonlyArray<Fault>) {
  const declarations = Array.map(faults, Struct.get("declaration"))
  const problems = Array.flatMap(declarations, declarationProblems(catalog, declarations))

  if (Array.isReadonlyArrayEmpty(declarations)) return yield* faultsFailure("The definition declares no faults")

  const problemList = Array.join(problems, "; ")

  if (Array.isReadonlyArrayNonEmpty(problems)) return yield* faultsFailure(`Invalid fault declarations: ${problemList}`)

  return declarations
})

const overridden = (configuration: RunConfiguration, fault: FaultDeclaration) => RunConfiguration.make({
  ...configuration,
  maxActions: Option.getOrElse(fault.maxActions, Function.constant(configuration.maxActions)),
  deadlineSeconds: Option.getOrElse(fault.deadlineSeconds, Function.constant(configuration.deadlineSeconds)),
})

const scenarioIndex = (catalog: Catalog, id: string) => pipe(catalog.scenarios, Array.findFirstIndex(byId(id)), Option.getOrElse(Function.constant(0)))

const describeOutcome = (outcome: FaultOutcome) => {
  const results = pipe(outcome.results, Array.map(describeResult), Array.join(", "))

  return `${outcome.fault.id} (${outcome.fault.kind}, ${outcome.fault.scenario}): ${outcome.verdict}; interruption=${outcome.interruptionCategory}; actionCompletion=${outcome.actionCompletion}; ${results}`
}

const describeClean = (outcome: CleanOutcome) => {
  const results = pipe(outcome.results, Array.map(describeResult), Array.join(", "))

  return `clean ${outcome.scenario}: ${outcome.passed ? "pass" : "not-passed"}; actionCompletion=${outcome.actionCompletion}; ${results}`
}

const noSummary = Option.none<FaultsSummary>()

const resultLineage = (scope: string) => (result: RequirementResult) => LineageResult.make({ scope, requirement: result.requirement, status: result.status })

const faultLineage = (outcome: FaultOutcome) => Array.map(outcome.results, resultLineage(`fault:${outcome.fault.id}`))

const cleanLineage = (outcome: CleanOutcome) => Array.map(outcome.results, resultLineage(`clean:${outcome.scenario}`))

/**
 * Runs every declared fault's scenario through the normal runner path with the browser behind a fault proxy,
 * then each distinct fault scenario once without a proxy as a clean control, because detection is only meaningful
 * against a clean run of the same scenario on the same build.
 */
export const runFaults = Effect.fn("Acceptance.runFaults")(function* (definition: AcceptanceDefinition, configuration: RunConfiguration) {
  const evidence = yield* RunEvidence
  const fixtures = yield* FixtureRuntime
  const { catalog, requirements, assessments } = yield* validatedCatalog(definition)
  const [surfaces] = yield* validatedSurfaces(definition, catalog)
  const declarations = yield* validateFaults(catalog, definition.faults)
  const output = yield* evidence.directory(configuration.output)
  const reportPath = join(output, "faults.json")
  const alreadyExists = yield* evidence.exists(reportPath)

  if (alreadyExists) return yield* runnerFailure("evidence")("Output already contains faults.json; choose a fresh directory to preserve previous evidence")

  if (Option.isSome(configuration.replay)) return yield* faultsFailure("Fault runs are real Jev explorations; --replay is not accepted")

  if (Option.isNone(configuration.apiKey)) return yield* runnerFailure("decision")("TYPESAFE_API_KEY is required for real Jev fault exploration (never a mock fallback)")

  const build = yield* evidence.identify(definition.catalog, definition.catalogs)
  const startedAt = yield* now
  const marker = yield* claimOwnership(output, definition.policy, "faults", startedAt)
  const initialSecrets = Option.toArray(configuration.apiKey)
  const secrets = yield* Ref.make<ReadonlyArray<Secret>>(initialSecrets)
  const faultRuns = yield* Ref.make<ReadonlyArray<FaultOutcome>>([])
  const cleanRuns = yield* Ref.make<ReadonlyArray<CleanOutcome>>([])

  const retainedConfiguration = FaultsConfiguration.make({
    model: configuration.model,
    minimumConfidence: configuration.minimumConfidence,
    maxActions: configuration.maxActions,
    deadlineSeconds: configuration.deadlineSeconds,
    seed: configuration.seed,
    browser: browserConfiguration,
    mode: "real-jev-faults",
  })

  const report = (faults: ReadonlyArray<FaultOutcome>, clean: ReadonlyArray<CleanOutcome>, summary: Option.Option<FaultsSummary>, evidenceLeaks: ReadonlyArray<string>, finishedAt: Option.Option<string>, status: Option.Option<"pass" | "not-passed">) => FaultsReport.make({
    format: `${definition.format}+faults`,
    application: definition.name,
    startedAt,
    build,
    fixtureRevision: fixtures.revision,
    configuration: retainedConfiguration,
    faults,
    clean,
    summary,
    evidenceLeaks,
    limitation,
    finishedAt,
    status,
  })

  const saveProgress = Effect.fn("Acceptance.faultsProgress")(function* () {
    const faults = yield* Ref.get(faultRuns)
    const clean = yield* Ref.get(cleanRuns)
    const progress = report(faults, clean, noSummary, [], unfinished, undecided)

    yield* evidence.save(reportPath, FaultsReport, progress)
  })

  yield* saveProgress()

  const runFault = Effect.fn("Acceptance.runFault")(function* (fault: Fault) {
    const { declaration } = fault
    const scenario = yield* findById(catalog.scenarios, "scenario", declaration.scenario)
    const artifactsName = encodeURIComponent(declaration.id)
    const artifactsPath = join(output, artifactsName)
    const artifacts = yield* evidence.directory(artifactsPath)
    const injections = yield* Ref.make<ReadonlyArray<string>>([])
    const seed = configuration.seed + scenarioIndex(catalog, scenario.id)
    const plan = ScenarioPlan.make({ catalog, requirements, assessments, scenario, artifacts, configuration: overridden(configuration, declaration), seed, replay: Option.none() })
    const run = yield* playScenario(definition, surfaces, faultRoute(fault, injections), secrets)(plan)
    const injected = yield* Ref.get(injections)
    const outcome = faultOutcome(declaration, artifacts, injected)(run)

    yield* Ref.update(faultRuns, Array.append(outcome))
    yield* saveProgress()

    const line = describeOutcome(outcome)

    yield* Effect.logInfo(line)
  })

  const runClean = Effect.fn("Acceptance.runClean")(function* (id: string) {
    const scenario = yield* findById(catalog.scenarios, "scenario", id)
    const artifactsName = encodeURIComponent(id)
    const artifactsPath = join(output, "clean", artifactsName)
    const artifacts = yield* evidence.directory(artifactsPath)
    const seed = configuration.seed + scenarioIndex(catalog, id)
    const plan = ScenarioPlan.make({ catalog, requirements, assessments, scenario, artifacts, configuration, seed, replay: Option.none() })
    const run = yield* playScenario(definition, surfaces, directRoute, secrets)(plan)
    const outcome = cleanOutcome(artifacts)(run)

    yield* Ref.update(cleanRuns, Array.append(outcome))
    yield* saveProgress()

    const line = describeClean(outcome)

    yield* Effect.logInfo(line)
  })

  yield* Effect.forEach(definition.faults, runFault, { discard: true })

  const scenarios = pipe(declarations, Array.map(Struct.get("scenario")), Array.dedupe)

  yield* Effect.forEach(scenarios, runClean, { discard: true })

  const faults = yield* Ref.get(faultRuns)
  const clean = yield* Ref.get(cleanRuns)
  const retainedSecrets = yield* Ref.get(secrets)
  const summary = summaryOf(faults, clean)
  const qualified = summaryPassed(summary)
  const finishedAt = yield* now
  const summaryOption = Option.some(summary)
  const finishedAtOption = Option.some(finishedAt)
  const faultResults = Array.flatMap(faults, faultLineage)
  const cleanResults = Array.flatMap(clean, cleanLineage)
  const results = Array.appendAll(faultResults, cleanResults)
  const lineage = lineageBuild(build)

  const finish = Effect.fn("Acceptance.finishFaults")(function* (leaks: ReadonlyArray<string>) {
    const sealed = Array.isReadonlyArrayEmpty(leaks)
    const status = qualified && sealed ? "pass" : "not-passed"
    const statusOption = Option.some<typeof SliceStatusSchema.Type>(status)
    const finished = report(faults, clean, summaryOption, leaks, finishedAtOption, statusOption)

    yield* evidence.save(reportPath, FaultsReport, finished)

    return LineageFacts.make({
      finishedAt,
      status,
      build: lineage,
      catalog: catalog.id,
      catalogRevision: catalog.revision,
      imports: catalog.imports,
      results,
      replaySource: Option.none(),
      repair: Option.none(),
    })
  })

  const record = (facts: LineageFacts, sealed: Seal) => recordLineage(output, marker, facts, sealed)
  const leaks = yield* sealRun(output, definition.policy, retainedSecrets, finish, record)
  const passed = qualified && Array.isReadonlyArrayEmpty(leaks)
  const status = passed ? "pass" : "not-passed"

  yield* Effect.logInfo(`${definition.title} (${definition.name}) faults ${status}: ${summary.detected}/${summary.faults} defects detected, ${summary.falseAcceptance} false acceptance, ${summary.uncertain} uncertain, ${summary.controlsTruthful}/${summary.controls} controls truthful, ${summary.cleanPassed}/${summary.cleanControls} clean controls passed; evidence ${reportPath}. ${limitation}`)

  return passed
})
