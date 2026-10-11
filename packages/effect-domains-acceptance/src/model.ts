import { Context, Effect, Function, Option, Redacted, Schema, Scope } from "effect"
import { CalendarDateSchema } from "effect-domains/domain"

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

/** Distinguishes authored facts, agent- or implementation-proposed interpretations, and approved obligations because only the last may be executed. */
export const ApprovalSchema = Schema.Literals(["authored", "proposed", "approved"])

export const RevisionSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  revision: Schema.NonEmptyString,
  provenance: Schema.NonEmptyString,
  approval: ApprovalSchema,
})

export interface Revision extends Schema.Schema.Type<typeof RevisionSchema> {}

/** Names a declaration at its revision because approvals, queries, and evidence must refer to one exact revision of an obligation. */
export const qualified = (declaration: Revision) => `${declaration.id}@${declaration.revision}`

export const RequirementCategorySchema = Schema.Literals(["behavior", "preservation", "history", "authorization", "qualitative"])

class RequirementParameter extends Schema.Class<RequirementParameter>("RequirementParameter")({
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
}) {}

const ArgumentsSchema = Schema.Record(Schema.String, Schema.NonEmptyString)

/** A refinement binds a shared requirement's parameters because a reusable obligation is referenced, not copied, with its scope made explicit. */
export class Refinement extends Schema.Class<Refinement>("Refinement")({
  requirement: Schema.NonEmptyString,
  arguments: ArgumentsSchema,
}) {}

const ParametersSchema = Schema.Array(RequirementParameter)
const OptionalRefinementSchema = Schema.OptionFromOptionalKey(Refinement)
const OptionalIdentifierSchema = Schema.OptionFromOptionalKey(Schema.NonEmptyString)

/**
 * The evaluator binding is optional because a shared obligation may only be refined; scenarios may reference only evaluator-bound requirements.
 * A qualitative requirement names its review rubric because a model assessment is judged against declared criteria, never an implicit standard.
 */
export class Requirement extends Schema.Class<Requirement>("Requirement")({
  ...RevisionSchema.fields,
  text: Schema.NonEmptyString,
  evaluator: OptionalIdentifierSchema,
  evaluatorRevision: OptionalIdentifierSchema,
  category: RequirementCategorySchema,
  parameters: ParametersSchema,
  refines: OptionalRefinementSchema,
  rubric: OptionalIdentifierSchema,
}) {}

/** One ordered level of a review scale because a rating is meaningful only against its declared wording. */
export class RubricLevel extends Schema.Class<RubricLevel>("RubricLevel")({
  level: Schema.NonEmptyString,
  meaning: Schema.NonEmptyString,
}) {}

const RubricLevelsSchema = Schema.Array(RubricLevel)

/**
 * A review rubric is a separate revisioned declaration because its criteria, scale, pass threshold, and reviewer are a product judgment
 * that needs its own approval; the scale is ordered from worst to best and the threshold is the lowest passing level.
 */
export class Rubric extends Schema.Class<Rubric>("Rubric")({
  ...RevisionSchema.fields,
  criteria: IdentifiersSchema,
  scale: RubricLevelsSchema,
  threshold: Schema.NonEmptyString,
  reviewer: Schema.NonEmptyString,
}) {}

/** The executable form an evaluator receives because a scenario reference is resolved and evaluator-bound before execution. */
export class BoundRequirement extends Schema.Class<BoundRequirement>("BoundRequirement")({
  reference: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
  revision: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
  category: RequirementCategorySchema,
  evaluator: Schema.NonEmptyString,
  evaluatorRevision: Schema.NonEmptyString,
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

export const TextSourceSchema = Schema.Struct({
  source: Schema.Literal("text"),
  fixture: Schema.NonEmptyString,
  field: Schema.NonEmptyString,
})

export interface TextSource extends Schema.Schema.Type<typeof TextSourceSchema> {}

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

export const FieldSourceSchema = Schema.Union([FixtureSourceSchema, CapturedSourceSchema, TextSourceSchema, LiteralSourceSchema, NativeSourceSchema])

export type FieldSource = typeof FieldSourceSchema.Type

const FieldSourcesSchema = Schema.Record(Schema.String, FieldSourceSchema)

export const ValiditySchema = Schema.Literals(["native-valid", "native-invalid"])

const AcceptedOutcomeSchema = Schema.Struct({ kind: Schema.Literal("accepted") })

interface AcceptedOutcome extends Schema.Schema.Type<typeof AcceptedOutcomeSchema> {}

export const DeniedSchema = Schema.Struct({ kind: Schema.Literal("denied"), failure: Schema.NonEmptyString })

interface Denied extends Schema.Schema.Type<typeof DeniedSchema> {}

export const RejectedSchema = Schema.Struct({ kind: Schema.Literal("rejected") })

interface Rejected extends Schema.Schema.Type<typeof RejectedSchema> {}

/** A contended input is accepted when it wins its race and otherwise refused with one of the declared native failures, because which competitor wins, and which documented refusal the loser meets first, is not determined in advance. */
export const ContendedSchema = Schema.Struct({ kind: Schema.Literal("contended"), failures: Schema.NonEmptyArray(Schema.NonEmptyString) })

interface Contended extends Schema.Schema.Type<typeof ContendedSchema> {}

export const OutcomeSchema = Schema.Union([AcceptedOutcomeSchema, DeniedSchema, RejectedSchema, ContendedSchema])

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

const ProbesSchema = Schema.Array(Schema.NonEmptyString)

/** One isolated browser context of a concurrent scenario: its own goal and the declared inputs only it submits. */
export class Lane extends Schema.Class<Lane>("Lane")({
  id: Schema.NonEmptyString,
  goal: Schema.NonEmptyString,
  inputs: IdentifiersSchema,
}) {}

const LanesSchema = Schema.Array(Lane)
const BarrierSchema = Schema.Literal("submit")

/**
 * Concurrent lanes each run in a separate browser context against the same owned application; the harness owns only the declared
 * synchronization barrier, releasing every lane's chosen submission together once all lanes have arrived at it.
 */
export class Concurrency extends Schema.Class<Concurrency>("Concurrency")({
  barrier: BarrierSchema,
  lanes: LanesSchema,
}) {}

/**
 * A declared temporal contract: when the watched input's submission is released, the harness polls the fixture probe for the subject
 * fact every `intervalMillis` until the result's `field` names a terminal state or `deadlineSeconds` after the release elapse, then
 * repeats `confirmations` polls after a terminal state, because eventual completion is observed over time, not in one before/after pair.
 */
export class Watch extends Schema.Class<Watch>("Watch")({
  input: Schema.NonEmptyString,
  probe: Schema.NonEmptyString,
  subject: Schema.NonEmptyString,
  field: Schema.NonEmptyString,
  terminal: IdentifiersSchema,
  intervalMillis: Schema.Int,
  deadlineSeconds: Schema.Int,
  confirmations: Schema.Int,
}) {}

const OptionalConcurrencySchema = Schema.OptionFromOptionalKey(Concurrency)
const OptionalWatchSchema = Schema.OptionFromOptionalKey(Watch)

/** `assessments` are non-gating qualitative requirement references because a proposed review is reported, never counted as an obligation. */
export class Scenario extends Schema.Class<Scenario>("Scenario")({
  ...RevisionSchema.fields,
  story: Schema.NonEmptyString,
  actor: Schema.NonEmptyString,
  fixture: Schema.NonEmptyString,
  goal: Schema.NonEmptyString,
  operations: IdentifiersSchema,
  inputs: InputCasesSchema,
  required: IdentifiersSchema,
  observations: IdentifiersSchema,
  probes: ProbesSchema,
  requirements: IdentifiersSchema,
  assessments: IdentifiersSchema,
  reload: Schema.Boolean,
  concurrency: OptionalConcurrencySchema,
  watch: OptionalWatchSchema,
}) {}

/** The story's context is a reference because narrative circumstances and executable preconditions are declared separately. */
class Story extends Schema.Class<Story>("Story")({
  ...RevisionSchema.fields,
  original: Schema.NonEmptyString,
  actor: Schema.NonEmptyString,
  context: Schema.NonEmptyString,
  need: Schema.NonEmptyString,
  capabilities: IdentifiersSchema,
  requirements: IdentifiersSchema,
  nonGoals: IdentifiersSchema,
  openDecisions: IdentifiersSchema,
}) {}

export class Actor extends Schema.Class<Actor>("Actor")({
  ...RevisionSchema.fields,
  binding: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
}) {}

class Need extends Schema.Class<Need>("Need")({
  ...RevisionSchema.fields,
  text: Schema.NonEmptyString,
}) {}

export class Capability extends Schema.Class<Capability>("Capability")({
  ...RevisionSchema.fields,
  operations: IdentifiersSchema,
  resource: Schema.NonEmptyString,
}) {}

export class TextFixture extends Schema.Class<TextFixture>("TextFixture")({
  ...RevisionSchema.fields,
  values: PayloadSchema,
}) {}

/** Narrative circumstances stay apart from executable preconditions because scenarios may use only the fixture bindings their story's context admits. */
export class ProductContext extends Schema.Class<ProductContext>("ProductContext")({
  ...RevisionSchema.fields,
  narrative: Schema.NonEmptyString,
  fixtures: IdentifiersSchema,
}) {}

/** A product-level grouping of capabilities, unrelated to operational feature flags because it records product structure rather than runtime switches. */
export class Feature extends Schema.Class<Feature>("Feature")({
  ...RevisionSchema.fields,
  title: Schema.NonEmptyString,
  capabilities: IdentifiersSchema,
}) {}

/** An import pins another catalog's exact revision because a qualified reference must not silently follow a changed obligation. */
export class CatalogImport extends Schema.Class<CatalogImport>("CatalogImport")({
  alias: Schema.NonEmptyString,
  catalog: Schema.NonEmptyString,
  revision: Schema.NonEmptyString,
}) {}

/** One entry of the approval history because contract readiness requires an approval of the exact current id@revision. */
export class ApprovalRecord extends Schema.Class<ApprovalRecord>("ApprovalRecord")({
  id: Schema.NonEmptyString,
  by: Schema.NonEmptyString,
  on: CalendarDateSchema,
  basis: Schema.NonEmptyString,
  approves: IdentifiersSchema,
}) {}

const ActorsSchema = Schema.Array(Actor)
const NeedsSchema = Schema.Array(Need)
const CapabilitiesSchema = Schema.Array(Capability)
const TextFixturesSchema = Schema.Array(TextFixture)
const RequirementsSchema = Schema.Array(Requirement)
const StoriesSchema = Schema.Array(Story)
const ScenariosSchema = Schema.Array(Scenario)
const ContextsSchema = Schema.Array(ProductContext)
const FeaturesSchema = Schema.Array(Feature)
const ImportsSchema = Schema.Array(CatalogImport)
const ApprovalsSchema = Schema.Array(ApprovalRecord)
const RubricsSchema = Schema.Array(Rubric)

export class Catalog extends Schema.Class<Catalog>("Catalog")({
  ...RevisionSchema.fields,
  imports: ImportsSchema,
  approvals: ApprovalsSchema,
  actors: ActorsSchema,
  contexts: ContextsSchema,
  needs: NeedsSchema,
  capabilities: CapabilitiesSchema,
  features: FeaturesSchema,
  textFixtures: TextFixturesSchema,
  rubrics: RubricsSchema,
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
  provenance: Schema.String,
  seed: Schema.Int,
}) {}

/** When the browser sent a submission and received its response because concurrent submissions must be shown to have been in flight together. */
export class Exchange extends Schema.Class<Exchange>("Exchange")({
  sentAt: Schema.String,
  receivedAt: Schema.String,
}) {}

const OptionalExchangeSchema = Schema.OptionFromOptionalKey(Exchange)

/** `feedback` is the operation result or alert text the page rendered after the submission settled, because qualitative review judges what the user was shown. */
export class Submission extends Schema.Class<Submission>("Submission")({
  inputCase: Schema.NonEmptyString,
  operation: Schema.String,
  input: PayloadSchema,
  status: Schema.Int,
  result: OptionalValueSchema,
  error: OptionalValueSchema,
  at: Schema.String,
  exchange: OptionalExchangeSchema,
  feedback: OptionalTextSchema,
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

const AttributesSchema = Schema.Record(Schema.String, Schema.String)
const OptionalNameSchema = Schema.OptionFromOptionalKey(Schema.NonEmptyString)

/** The ARIA roles a custom binding may declare because repair resolves elements by role through the accessibility tree. */
export const AriaRoleSchema = Schema.Literals(["button", "row", "cell", "textbox", "combobox", "checkbox", "link", "option", "status", "listitem"])

/** What an element means independently of its presentation because locator repair may only re-resolve the same role, accessible name, and application attributes. */
export class ElementSemantics extends Schema.Class<ElementSemantics>("ElementSemantics")({
  role: AriaRoleSchema,
  name: OptionalNameSchema,
  attributes: AttributesSchema,
}) {}

/** One bound element of a custom-surface action: its declared presentation locator and the semantics it must keep. */
export class TargetPart extends Schema.Class<TargetPart>("TargetPart")({
  part: Schema.NonEmptyString,
  locator: Schema.NonEmptyString,
  scoped: Schema.Boolean,
  semantics: ElementSemantics,
}) {}

const TargetPartsSchema = Schema.Array(TargetPart)

/** How a row action finds its row: the application's identity attribute and the candidate field carrying the identity, never a position. */
export class RowIdentity extends Schema.Class<RowIdentity>("RowIdentity")({
  attribute: Schema.NonEmptyString,
  field: Schema.NonEmptyString,
}) {}

const OptionalRowIdentitySchema = Schema.OptionFromOptionalKey(RowIdentity)

/**
 * The explicit custom-UI binding an action was offered through because replay must compare both its locators and its semantic target.
 * The row identity is bound, not recorded, because each run's fixture issues fresh identities that the rebound candidate carries.
 */
export class CustomTarget extends Schema.Class<CustomTarget>("CustomTarget")({
  surface: Schema.NonEmptyString,
  action: Schema.NonEmptyString,
  row: OptionalRowIdentitySchema,
  parts: TargetPartsSchema,
}) {}

const OptionalCustomTargetSchema = Schema.OptionFromOptionalKey(CustomTarget)

export class Action extends Schema.Class<Action>("Action")({
  id: Schema.String,
  description: Schema.String,
  kind: ActionKindSchema,
  operation: OptionalTextSchema,
  inputCase: OptionalTextSchema,
  value: OptionalPayloadSchema,
  target: Schema.String,
  binding: OptionalCustomTargetSchema,
  snapshot: Schema.String,
}) {}

/** One part's live locator evidence because a repair must show the recorded locator failed and the semantic match is the current binding's single element. */
export class LocatorCheck extends Schema.Class<LocatorCheck>("LocatorCheck")({
  part: Schema.String,
  recorded: Schema.String,
  recordedMatches: Schema.Int,
  current: Schema.String,
  currentMatches: Schema.Int,
  semantic: Schema.String,
  semanticMatches: Schema.Int,
  sameElement: Schema.Boolean,
}) {}

const LocatorChecksSchema = Schema.Array(LocatorCheck)

/** Repair provenance retained on the repaired trace step because a repaired locator must keep its original failure and matched semantics inspectable. */
export class LocatorRepair extends Schema.Class<LocatorRepair>("LocatorRepair")({
  surface: Schema.String,
  action: Schema.String,
  operation: OptionalTextSchema,
  inputCase: OptionalTextSchema,
  identity: OptionalTextSchema,
  originalTarget: Schema.String,
  repairedTarget: Schema.String,
  failure: Schema.String,
  semantics: TargetPartsSchema,
  checks: LocatorChecksSchema,
}) {}

const OptionalRepairSchema = Schema.OptionFromOptionalKey(LocatorRepair)

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
  revision: Schema.String,
  url: Schema.String,
  actor: Schema.String,
  facts: FactsSchema,
  tracked: IdentifiersSchema,
}) {}

const SubmissionsSchema = Schema.Array(Submission)
const OptionalSubmissionSchema = Schema.OptionFromOptionalKey(Submission)

/** One lane reaching the barrier with its chosen submission because the release must be shown to follow every lane's arrival. */
export class BarrierArrival extends Schema.Class<BarrierArrival>("BarrierArrival")({
  lane: Schema.String,
  inputCase: Schema.String,
  arrivedAt: Schema.String,
}) {}

const BarrierArrivalsSchema = Schema.Array(BarrierArrival)

/** The harness-owned synchronization barrier of a concurrent scenario: who arrived, and when every held submission was released. */
export class BarrierRecord extends Schema.Class<BarrierRecord>("BarrierRecord")({
  barrier: Schema.String,
  lanes: Schema.Int,
  arrivals: BarrierArrivalsSchema,
  releasedAt: OptionalTextSchema,
}) {}

export const WatchOutcomeSchema = Schema.Literals(["terminal", "deadline"])

/** How a declared watch ended because a deadline expiry must stay distinguishable from an observed terminal state. */
export class WatchRecord extends Schema.Class<WatchRecord>("WatchRecord")({
  watch: Watch,
  startedAt: Schema.String,
  endedAt: Schema.String,
  outcome: WatchOutcomeSchema,
  terminalState: OptionalTextSchema,
  polls: Schema.Int,
}) {}

const OptionalBarrierSchema = Schema.OptionFromOptionalKey(BarrierRecord)
const OptionalWatchRecordSchema = Schema.OptionFromOptionalKey(WatchRecord)

export class EvaluationContext extends Schema.Class<EvaluationContext>("EvaluationContext")({
  scenario: Scenario,
  fixture: PreparedFixture,
  candidates: CandidatesSchema,
  submissions: SubmissionsSchema,
  before: ObservationsSchema,
  after: ObservationsSchema,
  probes: ProbeRecordsSchema,
  directProbe: OptionalSubmissionSchema,
  barrier: OptionalBarrierSchema,
  watch: OptionalWatchRecordSchema,
  interruption: OptionalTextSchema,
  evidence: TextsSchema,
}) {}

export const ResultStatusSchema = Schema.Literals(["pass", "fail", "blocked", "inconclusive"])

export const AssertionBasisSchema = Schema.Literal("executable assertion")

/** Assertion evidence and model assessments stay distinguishable on every result because a model's rating is never deterministic proof. */
export const ResultBasisSchema = Schema.Literals(["executable assertion", "model assessment"])

export class RequirementResult extends Schema.Class<RequirementResult>("RequirementResult")({
  requirement: Schema.String,
  requirementRevision: Schema.String,
  scenario: Schema.String,
  scenarioRevision: Schema.String,
  evaluator: Schema.String,
  evaluatorRevision: Schema.String,
  basis: ResultBasisSchema,
  status: ResultStatusSchema,
  explanation: Schema.String,
  evidence: TextsSchema,
}) {}

/** What the user was shown after one submission because a qualitative review judges the rendered feedback and its screenshot, not hidden state. */
export class AssessmentEvidence extends Schema.Class<AssessmentEvidence>("AssessmentEvidence")({
  inputCase: Schema.String,
  operation: Schema.String,
  status: Schema.Int,
  feedback: Schema.String,
  screenshot: OptionalTextSchema,
}) {}

const AssessmentEvidencesSchema = Schema.Array(AssessmentEvidence)

/** The model-facing review task: the requirement wording, its rubric, and the captured evidence. */
export class AssessmentRequest extends Schema.Class<AssessmentRequest>("AssessmentRequest")({
  requirement: Schema.String,
  rubric: Rubric,
  evidence: AssessmentEvidencesSchema,
}) {}

const OptionalAssessmentDecisionSchema = Schema.OptionFromOptionalKey(Decision)
const OptionalLevelSchema = Schema.OptionFromOptionalKey(Schema.String)
const OptionalThresholdSchema = Schema.OptionFromOptionalKey(Schema.Boolean)

/**
 * One non-gating qualitative assessment: the result (basis `model assessment`), the exact rubric revision and approvals it ran under,
 * the evidence shown to the model, and the retained model decision, because an unapproved rubric's rating is reported but never counted.
 */
export class AssessmentRun extends Schema.Class<AssessmentRun>("AssessmentRun")({
  result: RequirementResult,
  requirementApproval: ApprovalSchema,
  rubric: Rubric,
  evidence: AssessmentEvidencesSchema,
  decision: OptionalAssessmentDecisionSchema,
  level: OptionalLevelSchema,
  meetsThreshold: OptionalThresholdSchema,
}) {}

const AssessmentRunsSchema = Schema.Array(AssessmentRun)

const OptionalDecisionSchema = Schema.OptionFromOptionalKey(Decision)

export class TraceEntry extends Schema.Class<TraceEntry>("TraceEntry")({
  at: Schema.String,
  lane: OptionalTextSchema,
  action: Action,
  executed: Schema.Boolean,
  decision: OptionalDecisionSchema,
  observation: Observation,
  repair: OptionalRepairSchema,
}) {}

const TraceSchema = Schema.Array(TraceEntry)
const RequirementResultsSchema = Schema.Array(RequirementResult)

/** `assessments` are recorded apart from `results` because non-gating model assessments never count toward the pass gate or tested conformance. */
export class ScenarioRun extends Schema.Class<ScenarioRun>("ScenarioRun")({
  scenario: Scenario,
  fixture: PreparedFixture,
  candidates: CandidatesSchema,
  submissions: SubmissionsSchema,
  before: ObservationsSchema,
  after: ObservationsSchema,
  probes: ProbeRecordsSchema,
  directProbe: OptionalSubmissionSchema,
  barrier: OptionalBarrierSchema,
  watch: OptionalWatchRecordSchema,
  trace: TraceSchema,
  results: RequirementResultsSchema,
  assessments: AssessmentRunsSchema,
  interruption: OptionalTextSchema,
  actionCompletion: Schema.Boolean,
}) {}

export const FileHashSchema = Schema.Struct({ path: Schema.String, sha256: Schema.String })

interface FileHash extends Schema.Schema.Type<typeof FileHashSchema> {}

const FileHashesSchema = Schema.Array(FileHashSchema)

/** An imported catalog's exact content hash because an import changed without a revision bump must still make replays stale. */
export const ImportedCatalogSchema = Schema.Struct({ id: Schema.String, revision: Schema.String, sha256: Schema.String })

interface ImportedCatalog extends Schema.Schema.Type<typeof ImportedCatalogSchema> {}

const ImportedCatalogsSchema = Schema.Array(ImportedCatalogSchema)

export class BuildIdentity extends Schema.Class<BuildIdentity>("BuildIdentity")({
  application: Schema.String,
  sha256: Schema.String,
  files: FileHashesSchema,
  importedCatalogs: ImportedCatalogsSchema,
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
  /** Rates captured evidence against a rubric scale; the choice is a scale level, retained with its request, response, and probabilities. */
  assess: (request: AssessmentRequest) => Effect.Effect<Decision, AcceptanceError>
}>()("@effect-domains/acceptance/DecisionModel") {}

export class BrowserSurface extends Context.Service<BrowserSurface, {
  authenticate: (token: Redacted.Redacted<string>) => Effect.Effect<void, AcceptanceError>
  observe: (reloaded: boolean, screenshot: string) => Effect.Effect<Observation, AcceptanceError>
  capture: (operation: string, reloaded: boolean, screenshot: string) => Effect.Effect<Observation, AcceptanceError>
  actions: (offer: Offer) => Effect.Effect<ReadonlyArray<Action>, AcceptanceError>
  execute: (action: Action) => Effect.Effect<Option.Option<Submission>, AcceptanceError>
  /** Describes how a recorded custom-binding action's locators resolve now because a strict replay failure must retain the concrete locator failure. */
  diagnose: (recorded: Action) => Effect.Effect<string, AcceptanceError>
  /** Verifies live that a recorded locator failed and its semantic target resolves to exactly the current binding's element; fails when refused. */
  repair: (recorded: Action, current: Action) => Effect.Effect<LocatorRepair, AcceptanceError>
}>()("@effect-domains/acceptance/BrowserSurface") {}

/**
 * Holds a submitted request at the browser's network boundary until the hold succeeds, because a concurrent barrier must release requests
 * that are already pending, not clicks whose requests would then leave one after another. Only concurrent lanes provide a hold.
 */
export type RequestHold = Option.Option<(inputCase: string) => Effect.Effect<void, AcceptanceError>>

const unheld: RequestHold = Option.none()

export const RequestGate = Context.Reference<RequestHold>("@effect-domains/acceptance/RequestGate", { defaultValue: Function.constant(unheld) })

export class RequirementEvaluation extends Context.Service<RequirementEvaluation, {
  evaluate: (requirement: BoundRequirement, context: EvaluationContext) => Effect.Effect<RequirementResult, AcceptanceError>
}>()("@effect-domains/acceptance/RequirementEvaluation") {}

export class InputCandidates extends Context.Service<InputCandidates, {
  resolve: (scenario: Scenario, fixture: PreparedFixture, submissions: ReadonlyArray<Submission>, text: ReadonlyArray<TextFixture>, seed: number) => Effect.Effect<ReadonlyArray<Candidate>, AcceptanceError>
  replay: (scenario: Scenario, recorded: ReadonlyArray<Candidate>, fixture: PreparedFixture, submissions: ReadonlyArray<Submission>, text: ReadonlyArray<TextFixture>) => Effect.Effect<ReadonlyArray<Candidate>, AcceptanceError>
}>()("@effect-domains/acceptance/InputCandidates") {}

export class FixtureRuntime extends Context.Service<FixtureRuntime, {
  revision: string
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
  identify: (catalog: typeof Catalog.Encoded, imports: ReadonlyArray<typeof Catalog.Encoded>) => Effect.Effect<BuildIdentity, AcceptanceError>
  scan: (path: string, secrets: ReadonlyArray<Redacted.Redacted<string>>) => Effect.Effect<ReadonlyArray<string>, AcceptanceError>
}>()("@effect-domains/acceptance/RunEvidence") {}
