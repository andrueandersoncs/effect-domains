import { Context, type Effect, type Option, type Redacted, Schema, type Scope } from "effect"

export const PayloadSchema = Schema.Record(Schema.String, Schema.Unknown)

export type Payload = typeof PayloadSchema.Type

export class AcceptanceError extends Schema.TaggedError<AcceptanceError>()("AcceptanceError", {
  boundary: Schema.String,
  message: Schema.String,
}) {}

const IdentifiersSchema = Schema.Array(Schema.NonEmptyString)
const TextsSchema = Schema.Array(Schema.String)
const PayloadsSchema = Schema.Array(PayloadSchema)
const OptionalPayloadSchema = Schema.OptionFromOptionalKey(PayloadSchema)
const OptionalTextSchema = Schema.OptionFromOptionalKey(Schema.String)
const OptionalValueSchema = Schema.OptionFromOptionalKey(Schema.Unknown)
const ProbabilitiesSchema = Schema.Record(Schema.String, Schema.Number)

export class Actor extends Schema.Class<Actor>("Actor")({
  id: Schema.NonEmptyString,
  binding: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
}) {}

/** A requirement names the application evaluator that judges it because every obligation is checked by app-authored code. */
export class Requirement extends Schema.Class<Requirement>("Requirement")({
  id: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
  evaluator: Schema.NonEmptyString,
}) {}

export class Story extends Schema.Class<Story>("Story")({
  id: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
  actor: Schema.NonEmptyString,
  requirements: IdentifiersSchema,
}) {}

export const FixtureSourceSchema = Schema.Struct({
  source: Schema.Literal("fixture"),
  fact: Schema.NonEmptyString,
  offset: Schema.Int,
})

export interface FixtureSource extends Schema.Schema.Type<typeof FixtureSourceSchema> {}

export const CapturedSourceSchema = Schema.Struct({
  source: Schema.Literal("captured"),
  field: Schema.NonEmptyString,
  offset: Schema.Int,
})

export interface CapturedSource extends Schema.Schema.Type<typeof CapturedSourceSchema> {}

export const LiteralSourceSchema = Schema.Struct({
  source: Schema.Literal("literal"),
  value: Schema.Unknown,
})

interface LiteralSource extends Schema.Schema.Type<typeof LiteralSourceSchema> {}

export const NativeStrategySchema = Schema.Literals(["sample", "minimum", "maximum", "below", "above", "fractional", "null"])

export const NativeSourceSchema = Schema.Struct({
  source: Schema.Literal("native"),
  strategy: NativeStrategySchema,
})

interface NativeSource extends Schema.Schema.Type<typeof NativeSourceSchema> {}

export const FieldSourceSchema = Schema.Union([FixtureSourceSchema, CapturedSourceSchema, LiteralSourceSchema, NativeSourceSchema])

export type FieldSource = typeof FieldSourceSchema.Type

const FieldSourcesSchema = Schema.Record(Schema.String, FieldSourceSchema)

export const ValiditySchema = Schema.Literals(["native-valid", "native-invalid"])

const AcceptedOutcomeSchema = Schema.Struct({ kind: Schema.Literal("accepted") })

interface AcceptedOutcome extends Schema.Schema.Type<typeof AcceptedOutcomeSchema> {}

export const DeniedSchema = Schema.Struct({ kind: Schema.Literal("denied"), failure: Schema.NonEmptyString })

interface Denied extends Schema.Schema.Type<typeof DeniedSchema> {}

export const RejectedSchema = Schema.Struct({ kind: Schema.Literal("rejected") })

interface Rejected extends Schema.Schema.Type<typeof RejectedSchema> {}

export const OutcomeSchema = Schema.Union([AcceptedOutcomeSchema, DeniedSchema, RejectedSchema])

type Outcome = typeof OutcomeSchema.Type

export class InputCase extends Schema.Class<InputCase>("InputCase")({
  id: Schema.NonEmptyString,
  operation: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  fields: FieldSourcesSchema,
  validity: ValiditySchema,
  outcome: OutcomeSchema,
}) {}

const InputCasesSchema = Schema.Array(InputCase)

export class Scenario extends Schema.Class<Scenario>("Scenario")({
  id: Schema.NonEmptyString,
  story: Schema.NonEmptyString,
  actor: Schema.NonEmptyString,
  fixture: Schema.NonEmptyString,
  goal: Schema.NonEmptyString,
  operations: IdentifiersSchema,
  inputs: InputCasesSchema,
  required: IdentifiersSchema,
  observations: IdentifiersSchema,
  probes: IdentifiersSchema,
  requirements: IdentifiersSchema,
  reload: Schema.Boolean,
}) {}

const ActorsSchema = Schema.Array(Actor)
const RequirementsSchema = Schema.Array(Requirement)
const StoriesSchema = Schema.Array(Story)
const ScenariosSchema = Schema.Array(Scenario)

export class Catalog extends Schema.Class<Catalog>("Catalog")({
  id: Schema.NonEmptyString,
  actors: ActorsSchema,
  requirements: RequirementsSchema,
  stories: StoriesSchema,
  scenarios: ScenariosSchema,
}) {}

export class Candidate extends Schema.Class<Candidate>("Candidate")({
  inputCase: Schema.NonEmptyString,
  operation: Schema.NonEmptyString,
  description: Schema.String,
  input: PayloadSchema,
  sources: FieldSourcesSchema,
  validity: ValiditySchema,
  nativeValidation: Schema.String,
  seed: Schema.Int,
}) {}

export class Submission extends Schema.Class<Submission>("Submission")({
  inputCase: Schema.NonEmptyString,
  operation: Schema.String,
  input: PayloadSchema,
  status: Schema.Int,
  result: OptionalValueSchema,
  error: OptionalValueSchema,
  at: Schema.String,
}) {}

export class Observation extends Schema.Class<Observation>("Observation")({
  operation: Schema.String,
  resource: Schema.String,
  loaded: Schema.Boolean,
  unfiltered: Schema.Boolean,
  complete: Schema.Boolean,
  rows: PayloadsSchema,
  reloaded: Schema.Boolean,
  screenshot: OptionalTextSchema,
}) {}

const ObservationsSchema = Schema.Array(Observation)
const CandidatesSchema = Schema.Array(Candidate)

export const ActionKindSchema = Schema.Literals(["open", "fill", "submit", "reload", "observe", "cannot-proceed"])

export class Action extends Schema.Class<Action>("Action")({
  id: Schema.String,
  description: Schema.String,
  kind: ActionKindSchema,
  operation: OptionalTextSchema,
  inputCase: OptionalTextSchema,
  value: OptionalPayloadSchema,
  target: Schema.String,
  snapshot: Schema.String,
}) {}

export class Decision extends Schema.Class<Decision>("Decision")({
  choice: Schema.String,
  confidence: Schema.Number,
  probabilities: ProbabilitiesSchema,
  model: Schema.String,
  request: Schema.Unknown,
  response: Schema.Unknown,
}) {}

export class DecisionState extends Schema.Class<DecisionState>("DecisionState")({
  goal: Schema.String,
  view: Schema.Unknown,
  history: TextsSchema,
}) {}

export class Offer extends Schema.Class<Offer>("Offer")({
  operations: IdentifiersSchema,
  observations: IdentifiersSchema,
  candidates: CandidatesSchema,
  reload: Schema.Boolean,
}) {}

export class ProbeRecord extends Schema.Class<ProbeRecord>("ProbeRecord")({
  probe: Schema.NonEmptyString,
  phase: Schema.String,
  subject: Schema.String,
  actor: Schema.String,
  at: Schema.String,
  status: Schema.Int,
  result: OptionalValueSchema,
  error: OptionalValueSchema,
}) {}

const ProbeRecordsSchema = Schema.Array(ProbeRecord)

const FactsSchema = Schema.Record(Schema.String, Schema.Unknown)

export class PreparedFixture extends Schema.Class<PreparedFixture>("PreparedFixture")({
  binding: Schema.String,
  url: Schema.String,
  actor: Schema.String,
  facts: FactsSchema,
  tracked: IdentifiersSchema,
}) {}

const SubmissionsSchema = Schema.Array(Submission)

/** `directProbes` are the required submissions re-called directly against the server because enforcement must not rely on the UI alone. */
export class EvaluationContext extends Schema.Class<EvaluationContext>("EvaluationContext")({
  scenario: Scenario,
  fixture: PreparedFixture,
  candidates: CandidatesSchema,
  submissions: SubmissionsSchema,
  before: ObservationsSchema,
  after: ObservationsSchema,
  probes: ProbeRecordsSchema,
  directProbes: SubmissionsSchema,
  interruption: OptionalTextSchema,
  evidence: TextsSchema,
}) {}

export const ResultStatusSchema = Schema.Literals(["pass", "fail", "blocked", "inconclusive"])

export class RequirementResult extends Schema.Class<RequirementResult>("RequirementResult")({
  requirement: Schema.String,
  scenario: Schema.String,
  evaluator: Schema.String,
  status: ResultStatusSchema,
  explanation: Schema.String,
  evidence: TextsSchema,
}) {}

const OptionalDecisionSchema = Schema.OptionFromOptionalKey(Decision)

export class TraceEntry extends Schema.Class<TraceEntry>("TraceEntry")({
  at: Schema.String,
  action: Action,
  executed: Schema.Boolean,
  decision: OptionalDecisionSchema,
  observation: Observation,
}) {}

const TraceSchema = Schema.Array(TraceEntry)
const RequirementResultsSchema = Schema.Array(RequirementResult)

export class ScenarioRun extends Schema.Class<ScenarioRun>("ScenarioRun")({
  scenario: Scenario,
  fixture: PreparedFixture,
  candidates: CandidatesSchema,
  submissions: SubmissionsSchema,
  before: ObservationsSchema,
  after: ObservationsSchema,
  probes: ProbeRecordsSchema,
  directProbes: SubmissionsSchema,
  trace: TraceSchema,
  results: RequirementResultsSchema,
  interruption: OptionalTextSchema,
  actionCompletion: Schema.Boolean,
}) {}

export const FileHashSchema = Schema.Struct({ path: Schema.String, sha256: Schema.String })

interface FileHash extends Schema.Schema.Type<typeof FileHashSchema> {}

const FileHashesSchema = Schema.Array(FileHashSchema)

/** `sourceHash` covers authored sources and listed files, `bundleHash` the built outputs, because a replay is stale when either changes. */
export class BuildIdentity extends Schema.Class<BuildIdentity>("BuildIdentity")({
  application: Schema.String,
  sourceHash: Schema.String,
  bundleHash: Schema.String,
  files: FileHashesSchema,
  catalogHash: Schema.String,
  nativeContractsHash: Schema.String,
  nativeContracts: Schema.Unknown,
  effect: Schema.String,
  bun: Schema.String,
}) {}

export class ProbeTarget extends Schema.Class<ProbeTarget>("ProbeTarget")({
  probe: Schema.NonEmptyString,
  phase: Schema.String,
  subject: Schema.String,
}) {}

export class DecisionModel extends Context.Service<DecisionModel, {
  choose: (state: DecisionState, actions: ReadonlyArray<Action>) => Effect.Effect<Decision, AcceptanceError>
}>()("@effect-domains/acceptance/DecisionModel") {}

export class BrowserSurface extends Context.Service<BrowserSurface, {
  authenticate: (token: Redacted.Redacted<string>) => Effect.Effect<void, AcceptanceError>
  observe: (reloaded: boolean, screenshot: string) => Effect.Effect<Observation, AcceptanceError>
  capture: (operation: string, reloaded: boolean, screenshot: string) => Effect.Effect<Observation, AcceptanceError>
  actions: (offer: Offer) => Effect.Effect<ReadonlyArray<Action>, AcceptanceError>
  execute: (action: Action) => Effect.Effect<Option.Option<Submission>, AcceptanceError>
}>()("@effect-domains/acceptance/BrowserSurface") {}

export class RequirementEvaluation extends Context.Service<RequirementEvaluation, {
  evaluate: (requirement: Requirement, context: EvaluationContext) => Effect.Effect<RequirementResult, AcceptanceError>
}>()("@effect-domains/acceptance/RequirementEvaluation") {}

export class InputCandidates extends Context.Service<InputCandidates, {
  resolve: (scenario: Scenario, fixture: PreparedFixture, submissions: ReadonlyArray<Submission>, seed: number) => Effect.Effect<ReadonlyArray<Candidate>, AcceptanceError>
  replay: (scenario: Scenario, recorded: ReadonlyArray<Candidate>, fixture: PreparedFixture, submissions: ReadonlyArray<Submission>) => Effect.Effect<ReadonlyArray<Candidate>, AcceptanceError>
}>()("@effect-domains/acceptance/InputCandidates") {}

export class FixtureRuntime extends Context.Service<FixtureRuntime, {
  bindings: ReadonlyArray<string>
  actors: ReadonlyArray<string>
  facts: ReadonlyArray<string>
  probes: ReadonlyArray<string>
  prepare: (scenario: Scenario, binding: string, artifacts: string) => Effect.Effect<PreparedFixture, AcceptanceError, Scope.Scope>
  probe: (fixture: PreparedFixture, target: ProbeTarget) => Effect.Effect<ProbeRecord, AcceptanceError>
  direct: (fixture: PreparedFixture, candidate: Candidate) => Effect.Effect<Submission, AcceptanceError>
  session: (fixture: PreparedFixture) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, AcceptanceError>
  secrets: (fixture: PreparedFixture) => Effect.Effect<ReadonlyArray<Redacted.Redacted<string>>, AcceptanceError>
}>()("@effect-domains/acceptance/FixtureRuntime") {}

export class RunEvidence extends Context.Service<RunEvidence, {
  directory: (path: string) => Effect.Effect<string, AcceptanceError>
  exists: (path: string) => Effect.Effect<boolean, AcceptanceError>
  read: (path: string) => Effect.Effect<unknown, AcceptanceError>
  save: <A, I>(path: string, schema: Schema.Codec<A, I>, value: A) => Effect.Effect<void, AcceptanceError>
  identify: (catalog: typeof Catalog.Encoded) => Effect.Effect<BuildIdentity, AcceptanceError>
  scan: (path: string, secrets: ReadonlyArray<Redacted.Redacted<string>>) => Effect.Effect<ReadonlyArray<string>, AcceptanceError>
}>()("@effect-domains/acceptance/RunEvidence") {}
