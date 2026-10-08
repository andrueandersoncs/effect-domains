import { Context, Effect, Schema } from "effect"

export const PayloadSchema = Schema.Record(Schema.String, Schema.Unknown)
export type Payload = Schema.Schema.Type<typeof PayloadSchema>

export class AcceptanceError extends Schema.TaggedError<AcceptanceError>()("AcceptanceError", {
  boundary: Schema.String,
  message: Schema.String,
}) {}

export const RevisionSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  revision: Schema.NonEmptyString,
  provenance: Schema.NonEmptyString,
  approval: Schema.Literal("approved"),
})
export const RequirementSchema = Schema.Struct({
  ...RevisionSchema.fields,
  text: Schema.NonEmptyString,
  evaluator: Schema.NonEmptyString,
  evaluatorRevision: Schema.NonEmptyString,
  category: Schema.Literals(["behavior", "preservation"]),
})
export type Requirement = Schema.Schema.Type<typeof RequirementSchema>
export const ScenarioSchema = Schema.Struct({
  ...RevisionSchema.fields,
  story: Schema.NonEmptyString,
  operation: Schema.NonEmptyString,
  resource: Schema.NonEmptyString,
  fixture: Schema.NonEmptyString,
  actor: Schema.NonEmptyString,
  goal: Schema.NonEmptyString,
  textFixture: Schema.optionalKey(Schema.NonEmptyString),
  strategy: Schema.Literals(["sample", "minimum", "maximum", "below", "above", "fractional", "null", "omitted"]),
  expected: Schema.Literals(["accepted", "rejected"]),
  requirements: Schema.Array(Schema.NonEmptyString),
  reload: Schema.Boolean,
})
export type Scenario = Schema.Schema.Type<typeof ScenarioSchema>
export const StorySchema = Schema.Struct({
  ...RevisionSchema.fields,
  original: Schema.NonEmptyString,
  actor: Schema.NonEmptyString,
  context: Schema.NonEmptyString,
  need: Schema.NonEmptyString,
  capability: Schema.NonEmptyString,
  requirements: Schema.Array(Schema.NonEmptyString),
  nonGoals: Schema.Array(Schema.NonEmptyString),
  openDecisions: Schema.Array(Schema.NonEmptyString),
})
export const CatalogSchema = Schema.Struct({
  ...RevisionSchema.fields,
  actors: Schema.Array(Schema.Struct({ ...RevisionSchema.fields, binding: Schema.NonEmptyString, description: Schema.NonEmptyString })),
  needs: Schema.Array(Schema.Struct({ ...RevisionSchema.fields, text: Schema.NonEmptyString })),
  capabilities: Schema.Array(Schema.Struct({ ...RevisionSchema.fields, operations: Schema.Array(Schema.NonEmptyString), resource: Schema.NonEmptyString })),
  textFixtures: Schema.Array(Schema.Struct({ ...RevisionSchema.fields, values: PayloadSchema })),
  requirements: Schema.Array(RequirementSchema),
  stories: Schema.Array(StorySchema),
  scenarios: Schema.Array(ScenarioSchema),
})
export type Catalog = Schema.Schema.Type<typeof CatalogSchema>
export type Submission = Readonly<{ operation: string; input: Payload; status: number; result?: unknown; error?: string }>
export type Observation = Readonly<{
  loaded: boolean
  resource: string
  unfiltered: boolean
  rows: ReadonlyArray<Payload>
  reloaded: boolean
  screenshot?: string
}>
export type Candidate = Readonly<{ input: Payload; decoded: unknown; source: string; seed: number; strategy: string; valid: boolean; nativeValidation: string; omittedFields: ReadonlyArray<string> }>
export type Action = Readonly<{
  id: string
  description: string
  kind: "open" | "fill" | "submit" | "reload" | "observe" | "cannot-proceed"
  operation?: string
  path?: string
  value?: unknown
  target: string
  snapshot: string
}>
export type Decision = Readonly<{ choice: string; confidence: number; probabilities: Readonly<Record<string, number>>; model: string; request: unknown; response: unknown }>
export type EvaluationContext = Readonly<{
  scenario: Scenario
  candidate: Candidate
  before: Observation
  after: Observation
  sentinel: Payload
  target?: Payload
  created?: Payload
  submission?: Submission
  interruption?: string
  evidence: ReadonlyArray<string>
}>
export type RequirementResult = Readonly<{
  requirement: string
  requirementRevision: string
  scenario: string
  scenarioRevision: string
  evaluator: string
  evaluatorRevision: string
  basis: "executable assertion"
  status: "pass" | "fail" | "blocked" | "inconclusive"
  explanation: string
  evidence: ReadonlyArray<string>
}>
export class DecisionModel extends Context.Service<DecisionModel, {
  choose: (goal: string, state: unknown, actions: ReadonlyArray<Action>, history: ReadonlyArray<string>) => Effect.Effect<Decision, AcceptanceError>
}>()("reading-list/acceptance/DecisionModel") {}
export class BrowserSurface extends Context.Service<BrowserSurface, {
  observe: (reloaded: boolean, screenshot: string) => Effect.Effect<Observation, AcceptanceError>
  actions: (scenario: Scenario, candidate: Candidate, submitted: boolean, reloaded: boolean) => Effect.Effect<ReadonlyArray<Action>, AcceptanceError>
  execute: (action: Action) => Effect.Effect<Submission | undefined, AcceptanceError>
}>()("reading-list/acceptance/BrowserSurface") {}
export class RequirementEvaluation extends Context.Service<RequirementEvaluation, {
  evaluate: (requirement: Requirement, context: EvaluationContext) => Effect.Effect<RequirementResult, AcceptanceError>
}>()("reading-list/acceptance/RequirementEvaluation") {}
