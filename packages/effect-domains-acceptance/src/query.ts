import { Array, Effect, Equal, Function, type Layer, Match, Option, Order, Predicate, Record, Result, Schema, SchemaAST, String as Text, Struct, Tuple, flow, pipe } from "effect"
import type { ApplicationIR } from "effect-domains/application"
import { readdir } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { approvalLabel, isQualitative, unresolved } from "./assessment.ts"
import { CatalogBindings, type NativeOperation, amongst, nativeOperations, validateCatalog } from "./catalog.ts"
import { type EvidenceIdentity, evidenceLayer } from "./evidence.ts"
import { nativeStrategyApplies } from "./inputs.ts"
import type { AcceptanceDefinition } from "./runner.ts"

type NativeStrategy = typeof NativeStrategySchema.Type

import {
  AcceptanceError,
  ApprovalSchema,
  BoundRequirement,
  Catalog,
  ContendedSchema,
  DeniedSchema,
  FixtureRuntime,
  InputCase,
  LiteralSourceSchema,
  NativeSourceSchema,
  NativeStrategySchema,
  ResultStatusSchema,
  RunEvidence,
  TextSourceSchema,
  type Capability,
  type CapturedSource,
  type CatalogImport,
  type FieldSource,
  type FixtureSource,
  type Requirement,
  type Revision,
  type Scenario,
  type TextSource,
  qualified,
} from "./model.ts"

/** An application exposes its executed definition, build identity, and fixture bindings because consumer queries must read the same approved catalog the runner executes. */
export interface QueryApplication {
  readonly definition: AcceptanceDefinition
  readonly identity: EvidenceIdentity
  readonly fixtures: Layer.Layer<FixtureRuntime>
}

const TextsSchema = Schema.Array(Schema.String)
const OptionalRetainedTextSchema = Schema.OptionFromOptionalNullOr(Schema.String)
const OptionalTextSchema = Schema.OptionFromOptionalKey(Schema.String)

/** Retained results are decoded with only the fields queries need because every retained run format shares them while other report sections differ by format. */
class RetainedResult extends Schema.Class<RetainedResult>("RetainedResult")({
  requirement: Schema.String,
  requirementRevision: Schema.String,
  scenario: Schema.String,
  scenarioRevision: Schema.String,
  evaluator: Schema.String,
  evaluatorRevision: Schema.String,
  basis: Schema.String,
  status: ResultStatusSchema,
}) {}

class RetainedDeclaration extends Schema.Class<RetainedDeclaration>("RetainedDeclaration")({
  id: Schema.String,
  revision: Schema.String,
}) {}

const RetainedResultsSchema = Schema.Array(RetainedResult)
const OptionalRepairSchema = Schema.OptionFromOptionalKey(Schema.Unknown)

/** A trace entry is decoded only for its repair provenance because queries count repaired actions, never replay them. */
class RetainedTraceEntry extends Schema.Class<RetainedTraceEntry>("RetainedTraceEntry")({
  repair: OptionalRepairSchema,
}) {}

const RetainedTraceSchema = Schema.Array(RetainedTraceEntry)
const OptionalTraceSchema = Schema.OptionFromOptionalKey(RetainedTraceSchema)

class RetainedRubric extends Schema.Class<RetainedRubric>("RetainedRubric")({
  id: Schema.String,
  revision: Schema.String,
  approval: ApprovalSchema,
}) {}

const OptionalLevelSchema = Schema.OptionFromOptionalKey(Schema.String)

/** A retained non-gating assessment because benefit is reported only from model assessments, labeled with the approval state they ran under. */
class RetainedAssessment extends Schema.Class<RetainedAssessment>("RetainedAssessment")({
  result: RetainedResult,
  requirementApproval: ApprovalSchema,
  rubric: RetainedRubric,
  level: OptionalLevelSchema,
}) {}

const RetainedAssessmentsSchema = Schema.Array(RetainedAssessment)
const OptionalAssessmentsSchema = Schema.OptionFromOptionalKey(RetainedAssessmentsSchema)

class RetainedScenario extends Schema.Class<RetainedScenario>("RetainedScenario")({
  scenario: RetainedDeclaration,
  results: RetainedResultsSchema,
  assessments: OptionalAssessmentsSchema,
  interruption: OptionalRetainedTextSchema,
  trace: OptionalTraceSchema,
}) {}

/** Only the run mode is decoded from the retained configuration because a repaired replay must be distinguishable from a strict one. */
class RetainedConfiguration extends Schema.Class<RetainedConfiguration>("RetainedConfiguration")({
  mode: OptionalTextSchema,
}) {}

const OptionalConfigurationSchema = Schema.OptionFromOptionalKey(RetainedConfiguration)

class RetainedBuild extends Schema.Class<RetainedBuild>("RetainedBuild")({
  application: Schema.String,
  sha256: Schema.String,
  catalogHash: Schema.String,
}) {}

const RetainedScenariosSchema = Schema.Array(RetainedScenario)

export class RetainedRun extends Schema.Class<RetainedRun>("RetainedRun")({
  format: Schema.String,
  startedAt: Schema.String,
  finishedAt: OptionalRetainedTextSchema,
  sliceStatus: OptionalRetainedTextSchema,
  build: RetainedBuild,
  catalog: RetainedDeclaration,
  scenarios: RetainedScenariosSchema,
  configuration: OptionalConfigurationSchema,
}) {}

/** A retained run keeps its directory because every query answer must point at inspectable evidence. */
class EvidenceRun extends Schema.Class<EvidenceRun>("EvidenceRun")({
  path: Schema.String,
  run: RetainedRun,
}) {}

export class UnreadableRun extends Schema.Class<UnreadableRun>("UnreadableRun")({
  path: Schema.String,
  problem: Schema.String,
}) {}

const EvidenceRunsSchema = Schema.Array(EvidenceRun)
const UnreadableRunsSchema = Schema.Array(UnreadableRun)

export class EvidenceScan extends Schema.Class<EvidenceScan>("EvidenceScan")({
  root: Schema.String,
  runs: EvidenceRunsSchema,
  unreadable: UnreadableRunsSchema,
}) {}

export class CurrentBuild extends Schema.Class<CurrentBuild>("CurrentBuild")({
  sha256: Schema.String,
  catalogHash: Schema.String,
}) {}

export class ImportedCatalog extends Schema.Class<ImportedCatalog>("ImportedCatalog")({
  alias: Schema.String,
  catalog: Catalog,
}) {}

const BoundRequirementsSchema = Schema.Array(BoundRequirement)
const ImportedCatalogsSchema = Schema.Array(ImportedCatalog)
const EvaluatorsSchema = Schema.Record(Schema.String, Schema.String)
const StrategiesSchema = Schema.Array(NativeStrategySchema)

/**
 * One native payload field's declared vocabulary because partition coverage can only be judged where the native schema enumerates
 * members or bounds a number: `members` are the JSON texts of a literal or enum field, `strategies` the boundary strategies the interpreter applies.
 */
class NativeField extends Schema.Class<NativeField>("NativeField")({
  operation: Schema.String,
  field: Schema.String,
  members: TextsSchema,
  strategies: StrategiesSchema,
}) {}

const NativeFieldsSchema = Schema.Array(NativeField)

/** The queried product joins one validated catalog, its pinned imports, the native operations and their field vocabulary, the current build, and the application's retained runs. */
export class Product extends Schema.Class<Product>("Product")({
  application: Schema.String,
  title: Schema.String,
  catalog: Catalog,
  requirements: BoundRequirementsSchema,
  imports: ImportedCatalogsSchema,
  operations: TextsSchema,
  fields: NativeFieldsSchema,
  evaluators: EvaluatorsSchema,
  current: CurrentBuild,
  runs: EvidenceRunsSchema,
  unreadable: UnreadableRunsSchema,
}) {}

/** One requirement as exercised by one scenario because tested conformance exists only per exercised scope. */
class ExercisedScope extends Schema.Class<ExercisedScope>("ExercisedScope")({
  scenario: Schema.String,
  scenarioRevision: Schema.String,
  story: Schema.String,
  requirement: Schema.String,
  requirementRevision: Schema.String,
  evaluator: Schema.String,
  evaluatorRevision: Schema.String,
}) {}

export class RecordedResult extends Schema.Class<RecordedResult>("RecordedResult")({
  run: Schema.String,
  format: Schema.String,
  build: Schema.String,
  startedAt: Schema.String,
  finished: Schema.Boolean,
  scenario: Schema.String,
  status: ResultStatusSchema,
  basis: Schema.String,
  staleness: TextsSchema,
  mode: OptionalTextSchema,
  repairs: Schema.Int,
}) {}

export const ScopeStateSchema = Schema.Literals(["pass", "fail", "blocked", "inconclusive", "missing", "stale"])

type ScopeState = typeof ScopeStateSchema.Type

const OptionalRecordedSchema = Schema.OptionFromOptionalKey(RecordedResult)

export class ScopeEvidence extends Schema.Class<ScopeEvidence>("ScopeEvidence")({
  scope: ExercisedScope,
  state: ScopeStateSchema,
  latest: OptionalRecordedSchema,
}) {}

export const ImplementationStateSchema = Schema.Literals(["bound", "no-scenario", "no-evaluator", "assessment"])

/** Implementation status records only what declarations bind to the native contract because whether it behaves correctly is tested conformance. */
class ImplementationStatus extends Schema.Class<ImplementationStatus>("ImplementationStatus")({
  state: ImplementationStateSchema,
  detail: Schema.String,
}) {}

export const ConformanceStateSchema = Schema.Literals(["exercised-scope-passes", "partial", "failing", "untested"])

type ConformanceState = typeof ConformanceStateSchema.Type

/** Tested conformance counts exercised scopes on the current build because a passing subset must never read as completion. */
class Conformance extends Schema.Class<Conformance>("Conformance")({
  state: ConformanceStateSchema,
  passing: Schema.Int,
  scopes: Schema.Int,
  summary: Schema.String,
}) {}

export class BuildEvidence extends Schema.Class<BuildEvidence>("BuildEvidence")({
  build: Schema.String,
  current: Schema.Boolean,
  run: Schema.String,
  startedAt: Schema.String,
  statuses: TextsSchema,
}) {}

const ScopeEvidencesSchema = Schema.Array(ScopeEvidence)
const BuildEvidencesSchema = Schema.Array(BuildEvidence)

export class RequirementEntry extends Schema.Class<RequirementEntry>("RequirementEntry")({
  reference: Schema.String,
  owner: Schema.String,
  revision: Schema.String,
  text: Schema.String,
  category: Schema.String,
  evaluator: OptionalTextSchema,
  refines: OptionalTextSchema,
  refinedBy: TextsSchema,
  stories: TextsSchema,
  scopes: ScopeEvidencesSchema,
  builds: BuildEvidencesSchema,
  implementation: ImplementationStatus,
  conformance: Conformance,
  benefit: Schema.String,
}) {}

const RequirementEntriesSchema = Schema.Array(RequirementEntry)

export class RequirementView extends Schema.Class<RequirementView>("RequirementView")({
  application: Schema.String,
  current: CurrentBuild,
  entries: RequirementEntriesSchema,
  unreadable: UnreadableRunsSchema,
}) {}

export class InputSummary extends Schema.Class<InputSummary>("InputSummary")({
  id: Schema.String,
  validity: Schema.String,
  outcome: Schema.String,
  fields: TextsSchema,
}) {}

const InputSummariesSchema = Schema.Array(InputSummary)

export class OperationScenario extends Schema.Class<OperationScenario>("OperationScenario")({
  scenario: Schema.String,
  story: Schema.String,
  inputs: InputSummariesSchema,
  scopes: ScopeEvidencesSchema,
}) {}

const OperationScenariosSchema = Schema.Array(OperationScenario)

export class OperationEntry extends Schema.Class<OperationEntry>("OperationEntry")({
  operation: Schema.String,
  native: Schema.Boolean,
  capabilities: TextsSchema,
  features: TextsSchema,
  stories: TextsSchema,
  requirements: TextsSchema,
  scenarios: OperationScenariosSchema,
}) {}

const OperationEntriesSchema = Schema.Array(OperationEntry)

export class ImplementationView extends Schema.Class<ImplementationView>("ImplementationView")({
  application: Schema.String,
  current: CurrentBuild,
  operations: OperationEntriesSchema,
}) {}

export class QaScenario extends Schema.Class<QaScenario>("QaScenario")({
  scenario: Schema.String,
  story: Schema.String,
  reasons: TextsSchema,
  scopes: ScopeEvidencesSchema,
}) {}

const QaScenariosSchema = Schema.Array(QaScenario)

/** `assessments` lists every declared non-gating assessment with its latest model assessment because unresolved qualitative reviews stay visible apart from scenario states. */
export class QaView extends Schema.Class<QaView>("QaView")({
  application: Schema.String,
  current: CurrentBuild,
  needingRun: QaScenariosSchema,
  failing: QaScenariosSchema,
  passing: Schema.Int,
  scenarios: Schema.Int,
  summary: Schema.String,
  assessments: TextsSchema,
  unreadable: UnreadableRunsSchema,
}) {}

export class JourneyStory extends Schema.Class<JourneyStory>("JourneyStory")({
  story: Schema.String,
  original: Schema.String,
  context: Schema.String,
  need: Schema.String,
  capabilities: TextsSchema,
  requirements: TextsSchema,
  scenarios: TextsSchema,
  nonGoals: TextsSchema,
}) {}

const JourneyStoriesSchema = Schema.Array(JourneyStory)

export class Journey extends Schema.Class<Journey>("Journey")({
  actor: Schema.String,
  description: Schema.String,
  stories: JourneyStoriesSchema,
}) {}

const JourneysSchema = Schema.Array(Journey)

export class DocumentationView extends Schema.Class<DocumentationView>("DocumentationView")({
  application: Schema.String,
  title: Schema.String,
  current: CurrentBuild,
  journeys: JourneysSchema,
}) {}

/** Declared-vocabulary coverage of one native operation because partition gaps are reported only where the declared vocabulary permits, never as exhaustiveness of authored predicates. */
class PartitionCoverage extends Schema.Class<PartitionCoverage>("PartitionCoverage")({
  operation: Schema.String,
  inputCases: Schema.Int,
  overlaps: TextsSchema,
  unexercisedMembers: TextsSchema,
  boundaries: TextsSchema,
}) {}

const PartitionCoveragesSchema = Schema.Array(PartitionCoverage)

export class GapView extends Schema.Class<GapView>("GapView")({
  application: Schema.String,
  capabilitiesWithoutNeed: TextsSchema,
  needsWithoutCapabilities: TextsSchema,
  requirementsWithoutScenarios: TextsSchema,
  storiesWithoutScenarios: TextsSchema,
  operationsWithoutCapability: TextsSchema,
  refinements: TextsSchema,
  unrefinedShared: TextsSchema,
  partitionScope: Schema.String,
  partitions: PartitionCoveragesSchema,
}) {}

export class ImpactView extends Schema.Class<ImpactView>("ImpactView")({
  application: Schema.String,
  changed: Schema.String,
  matches: TextsSchema,
  declarations: TextsSchema,
  scenarios: TextsSchema,
  runs: TextsSchema,
  caveat: Schema.String,
}) {}

export const impactCaveat = "Candidates from recorded dependencies only; unrecorded cross-feature effects may exist."

export const notAssessed = "not assessed"

const runFile = "run.json"
const needsRunStates: ReadonlyArray<ScopeState> = ["missing", "stale", "blocked", "inconclusive"]
const scopeStates: ReadonlyArray<ScopeState> = ["pass", "fail", "blocked", "inconclusive", "missing", "stale"]

const queryFailure = (message: string) => AcceptanceError.make({ boundary: "query", message })
const describeQueryFailure = flow(String, queryFailure)
const short = Text.slice(0, 12)
const fieldIs = <S extends object, K extends keyof S>(key: K) => (value: S[K]) => flow(Struct.get<S, K>(key), Equal.equals(value))
const withId = fieldIs<Revision, "id">("id")
const sameText = (left: string) => (right: string) => Equal.equals(left, right)
const isRunFile = (path: string) => pipe(path, basename, sameText(runFile))
const byStartedAt = Order.mapInput(Order.String, Struct.get<RecordedResult, "startedAt">("startedAt"))
const newestFirst = Order.flip(byStartedAt)

const decodeRun = Schema.decodeUnknownEffect(RetainedRun)
const decodeCatalog = Schema.decodeUnknownEffect(Catalog)
const listingOptions = { recursive: true } as const

const readJson = (filename: string) => Effect.tryPromise({ try: () => Bun.file(filename).json(), catch: String })

const retainedAt = (path: string) => (run: RetainedRun) => EvidenceRun.make({ path, run })

const unreadableAt = (path: string) => (problem: string) => UnreadableRun.make({ path, problem })

const describeDecodeFailure = (error: Schema.SchemaError) => `not a readable acceptance run: ${error.message}`

const readRetained = (root: string) => (file: string) => {
  const path = dirname(file)
  const filename = join(root, file)
  const decoded = pipe(readJson(filename), Effect.flatMap(flow(decodeRun, Effect.mapError(describeDecodeFailure))))

  return pipe(decoded, Effect.map(retainedAt(path)), Effect.mapError(unreadableAt(path)), Effect.result)
}

const pathOrder = Order.mapInput(Order.String, Struct.get<EvidenceRun, "path">("path"))

/** Reads every retained run.json under the root because a query must account for each run, reporting undecodable ones instead of dropping them. */
export const readEvidence = Effect.fn("Acceptance.query.readEvidence")(function* (root: string) {
  const listed = yield* Effect.tryPromise({ try: () => readdir(root, listingOptions), catch: describeQueryFailure })
  const files = pipe(listed, Array.filter(isRunFile), Array.sort(Order.String))
  const results = yield* Effect.forEach(files, readRetained(root))
  const runs = pipe(results, Array.getSuccesses, Array.sort(pathOrder))
  const unreadable = Array.getFailures(results)

  return EvidenceScan.make({ root, runs, unreadable })
})

const bindingsFor = Effect.fn("Acceptance.query.bindings")(function* (definition: AcceptanceDefinition) {
  const fixtures = yield* FixtureRuntime

  return CatalogBindings.make({
    evaluators: definition.evaluators,
    fixtures: fixtures.bindings,
    actors: fixtures.actors,
    facts: fixtures.facts,
    probes: fixtures.probes,
    catalogs: definition.catalogs,
  })
})

const currentBuildOf = Effect.fn("Acceptance.query.currentBuild")(function* (definition: AcceptanceDefinition) {
  const evidence = yield* RunEvidence
  const build = yield* evidence.identify(definition.catalog, definition.catalogs)

  return CurrentBuild.make({ sha256: build.sha256, catalogHash: build.catalogHash })
})

const pinnedBy = (entry: CatalogImport) => (declaration: typeof Catalog.Encoded) => {
  const name = qualified(declaration)

  return Equal.equals(name, `${entry.catalog}@${entry.revision}`)
}

const invalidImport = (error: Schema.SchemaError) => queryFailure(error.message)

const importedFrom = (registry: ReadonlyArray<typeof Catalog.Encoded>) => Effect.fn("Acceptance.query.imported")(function* (entry: CatalogImport) {
  const missing = queryFailure(`Missing import ${entry.alias} (${entry.catalog}@${entry.revision})`)
  const declaration = yield* pipe(registry, Array.findFirst(pinnedBy(entry)), Effect.fromOption, Effect.mapError(Function.constant(missing)))
  const catalog = yield* pipe(declaration, decodeCatalog, Effect.mapError(invalidImport))

  return ImportedCatalog.make({ alias: entry.alias, catalog })
})

const ofApplication = (name: string) => (entry: EvidenceRun) => Equal.equals(entry.run.build.application, name)

const memberText = (literal: SchemaAST.LiteralValue) => Predicate.isBigInt(literal) ? `${literal}n` : JSON.stringify(literal)

const enumValue = ([, value]: readonly [string, string | number]) => JSON.stringify(value)

const nullMembers = pipe("null", Array.of, Option.some)

const literalMember = (ast: SchemaAST.Literal) => pipe(ast.literal, memberText, Array.of, Option.some)

const enumMembers = (ast: SchemaAST.Enum) => pipe(ast.enums, Array.map(enumValue), Option.some)

const unionMembers = (ast: SchemaAST.Union): Option.Option<ReadonlyArray<string>> => pipe(ast.types, Array.map(enumeratedMembers), Option.all, Option.map(Array.flatten))

/** The members of a field whose decoded type is a literal, an enum, or a union of them (null included) because only such a field declares a finite vocabulary. */
const enumeratedMembers = (ast: SchemaAST.AST) => pipe(
  Match.value(ast),
  Match.tag("Literal", literalMember),
  Match.tag("Enum", enumMembers),
  Match.tag("Null", Function.constant(nullMembers)),
  Match.tag("Union", unionMembers),
  Match.orElse(Option.none<ReadonlyArray<string>>),
)

const boundaryStrategies: ReadonlyArray<NativeStrategy> = ["minimum", "maximum", "below", "above", "fractional"]

const nativeFieldOf = (operation: NativeOperation) => (signature: SchemaAST.PropertySignature) => {
  const field = String(signature.name)
  const members = pipe(signature.type, enumeratedMembers, Option.getOrElse(Array.empty<string>))
  const strategies = Array.filter(boundaryStrategies, nativeStrategyApplies(operation, field))

  return NativeField.make({ operation: operation._tag, field, members, strategies })
}

const decodedSignatures = (operation: NativeOperation) => pipe(
  operation.payloadSchema.ast,
  SchemaAST.toType,
  Option.liftPredicate(SchemaAST.isObjects),
  Option.map(Struct.get("propertySignatures")),
  Option.getOrElse(Array.empty<SchemaAST.PropertySignature>),
)

const operationFields = (operation: NativeOperation) => pipe(operation, decodedSignatures, Array.map(nativeFieldOf(operation)))

const hasVocabulary = (native: NativeField) => {
  const enumerated = Array.isReadonlyArrayNonEmpty(native.members)

  return enumerated || Array.isReadonlyArrayNonEmpty(native.strategies)
}

/** Every native payload field with an enumerated or bounded vocabulary because partition coverage is judged only against what the native schema declares. */
export const nativeFieldsOf = (application: ApplicationIR) => pipe(application, nativeOperations, Array.flatMap(operationFields), Array.filter(hasVocabulary))

/** Loads one application's product through the runner's own validation because consumers may only query a contract-ready catalog. */
export const loadProduct = Effect.fn("Acceptance.query.loadProduct")(function* (application: QueryApplication, scan: EvidenceScan) {
  const { definition } = application
  const bindings = yield* pipe(bindingsFor(definition), Effect.provide(application.fixtures))
  const validated = yield* validateCatalog(definition.catalog, bindings, definition.application)
  const imports = yield* Effect.forEach(validated.catalog.imports, importedFrom(definition.catalogs))
  const evidence = evidenceLayer(application.identity)
  const current = yield* pipe(currentBuildOf(definition), Effect.provide(evidence))
  const operations = pipe(definition.application, nativeOperations, Array.map(Struct.get("_tag")))
  const fields = nativeFieldsOf(definition.application)
  const runs = Array.filter(scan.runs, ofApplication(definition.name))

  return Product.make({
    application: definition.name,
    title: definition.title,
    catalog: validated.catalog,
    requirements: validated.requirements,
    imports,
    operations,
    fields,
    evaluators: definition.evaluators,
    current,
    runs,
    unreadable: scan.unreadable,
  })
})

const declaresRequirement = (id: string) => (entry: ImportedCatalog) => Array.some(entry.catalog.requirements, withId(id))
const aliased = fieldIs<ImportedCatalog, "alias">("alias")
const ownedKey = (id: string) => (catalog: Catalog) => `${catalog.id}/${id}`
const importKey = (id: string) => flow(Struct.get<ImportedCatalog, "catalog">("catalog"), ownedKey(id))

const unqualifiedKey = (product: Product, id: string) => {
  const local = Array.some(product.catalog.requirements, withId(id))
  const provider = Array.findFirst(product.imports, declaresRequirement(id))
  const imported = pipe(provider, Option.map(importKey(id)), Option.getOrElse(Function.constant(`?/${id}`)))

  return local ? ownedKey(id)(product.catalog) : imported
}

const qualifiedKey = (product: Product, alias: string, id: string) => pipe(
  product.imports,
  Array.findFirst(aliased(alias)),
  Option.map(importKey(id)),
  Option.getOrElse(Function.constant(`${alias}?/${id}`)),
)

/** Resolves an authored reference to owner/id because local, qualified, and imported references to one obligation must compare equal. */
const keyOf = (product: Product) => (reference: string) => {
  const parts = Text.split(reference, ":")
  const alias = Array.headNonEmpty(parts)
  const target = Array.get(parts, 1)

  return Option.match(target, { onNone: () => unqualifiedKey(product, reference), onSome: (id) => qualifiedKey(product, alias, id) })
}

const referencesKey = (product: Product, keys: ReadonlyArray<string>) => (references: ReadonlyArray<string>) => pipe(references, Array.map(keyOf(product)), Array.some(amongst(keys)))

const boundAs = fieldIs<BoundRequirement, "reference">("reference")

const scopeOf = (product: Product, scenario: Scenario) => (reference: string) => {
  const bound = Array.findFirst(product.requirements, boundAs(reference))

  const scope = (requirement: BoundRequirement) => ExercisedScope.make({
    scenario: scenario.id,
    scenarioRevision: scenario.revision,
    story: scenario.story,
    requirement: reference,
    requirementRevision: requirement.revision,
    evaluator: requirement.evaluator,
    evaluatorRevision: requirement.evaluatorRevision,
  })

  return Option.map(bound, scope)
}

const scenarioScopes = (product: Product) => (scenario: Scenario) => pipe(scenario.requirements, Array.map(scopeOf(product, scenario)), Array.getSomes)

const scenarioIs = (id: string) => (entry: RetainedScenario) => Equal.equals(entry.scenario.id, id)
const resultFor = fieldIs<RetainedResult, "requirement">("requirement")

const flagged = ([stale]: readonly [boolean, string]) => stale

const stalenessOf = (product: Product, scope: ExercisedScope, entry: EvidenceRun, result: RetainedResult) => {
  const { build, catalog } = entry.run
  const { current } = product
  const recordedBuild = short(build.sha256)
  const currentBuild = short(current.sha256)
  const recordedDeclaration = short(build.catalogHash)
  const currentDeclaration = short(current.catalogHash)
  const currentEvaluator = `${scope.evaluator}@${scope.evaluatorRevision}`
  const recordedEvaluator = `${result.evaluator}@${result.evaluatorRevision}`
  const staleBuild = !Equal.equals(build.sha256, current.sha256)
  const staleDeclaration = !Equal.equals(build.catalogHash, current.catalogHash)
  const staleCatalog = !Equal.equals(catalog.revision, product.catalog.revision)
  const staleScenario = !Equal.equals(result.scenarioRevision, scope.scenarioRevision)
  const staleRequirement = !Equal.equals(result.requirementRevision, scope.requirementRevision)
  const staleEvaluator = !Equal.equals(recordedEvaluator, currentEvaluator)
  const unfinished = Option.isNone(entry.run.finishedAt)

  const checks: ReadonlyArray<readonly [boolean, string]> = [
    [staleBuild, `build ${recordedBuild} is not the current build ${currentBuild}`],
    [staleDeclaration, `catalog declaration hash ${recordedDeclaration} is not the current ${currentDeclaration}`],
    [staleCatalog, `catalog revision ${catalog.revision} is not the current ${product.catalog.revision}`],
    [staleScenario, `scenario revision ${result.scenarioRevision} is not the current ${scope.scenarioRevision}`],
    [staleRequirement, `requirement revision ${result.requirementRevision} is not the current ${scope.requirementRevision}`],
    [staleEvaluator, `evaluator ${recordedEvaluator} is not the current ${currentEvaluator}`],
    [unfinished, "the run never finished, so its results are not current evidence"],
  ]

  return pipe(checks, Array.filter(flagged), Array.map(Tuple.get(1)))
}

const isRepaired = (entry: RetainedTraceEntry) => Option.isSome(entry.repair)

const noTrace = Array.empty<RetainedTraceEntry>()

const repairsIn = (run: RetainedRun, scenario: string) => pipe(
  run.scenarios,
  Array.filter(scenarioIs(scenario)),
  Array.flatMap(flow(Struct.get("trace"), Option.getOrElse(Function.constant(noTrace)))),
  Array.countBy(isRepaired),
)

const modeOf = (run: RetainedRun) => Option.flatMap(run.configuration, Struct.get("mode"))

const recordedAs = (product: Product, scope: ExercisedScope, entry: EvidenceRun) => (result: RetainedResult) => RecordedResult.make({
  run: entry.path,
  format: entry.run.format,
  build: entry.run.build.sha256,
  startedAt: entry.run.startedAt,
  finished: Option.isSome(entry.run.finishedAt),
  scenario: scope.scenario,
  status: result.status,
  basis: result.basis,
  staleness: stalenessOf(product, scope, entry, result),
  mode: modeOf(entry.run),
  repairs: repairsIn(entry.run, scope.scenario),
})

const recordedIn = (product: Product, scope: ExercisedScope) => (entry: EvidenceRun) => pipe(
  entry.run.scenarios,
  Array.filter(scenarioIs(scope.scenario)),
  Array.flatMap(Struct.get("results")),
  Array.filter(resultFor(scope.requirement)),
  Array.map(recordedAs(product, scope, entry)),
)

const recordedFor = (product: Product) => (scope: ExercisedScope) => pipe(product.runs, Array.flatMap(recordedIn(product, scope)), Array.sort(newestFirst))

const isFresh = (result: RecordedResult) => Array.isReadonlyArrayEmpty(result.staleness)

const recordedState = (result: RecordedResult): ScopeState => isFresh(result) ? result.status : "stale"

/** The newest current result wins, otherwise the newest stale one, because a later run on an old build must not hide current evidence. */
const latestOf = (results: ReadonlyArray<RecordedResult>) => {
  const fresh = pipe(results, Array.filter(isFresh), Array.head)
  const newest = Array.head(results)

  return Option.orElse(fresh, Function.constant(newest))
}

const evidenceOf = (product: Product) => (scope: ExercisedScope) => {
  const latest = pipe(scope, recordedFor(product), latestOf)
  const state = Option.match(latest, { onNone: Function.constant<ScopeState>("missing"), onSome: recordedState })

  return ScopeEvidence.make({ scope, state, latest })
}

const allScopes = (product: Product) => pipe(product.catalog.scenarios, Array.flatMap(scenarioScopes(product)), Array.map(evidenceOf(product)))

const inState = (state: ScopeState) => (evidence: ScopeEvidence) => Equal.equals(evidence.state, state)

const tallyOf = (scopes: ReadonlyArray<ScopeEvidence>) => (state: ScopeState): number => pipe(scopes, Array.filter(inState(state)), Array.length)

const tallyLabel = (scopes: ReadonlyArray<ScopeEvidence>) => (state: ScopeState) => {
  const tally = tallyOf(scopes)(state)

  return tally > 0 ? Option.some(`${tally} ${state}`) : Option.none()
}

/** Summarizes scope states as counts because a reader must see missing and stale scopes next to passes. */
export const stateSummary = (scopes: ReadonlyArray<ScopeEvidence>) => {
  const parts = pipe(scopeStates, Array.map(tallyLabel(scopes)), Array.getSomes)

  return Array.isReadonlyArrayNonEmpty(parts) ? Array.join(parts, ", ") : "no exercised scope"
}

const conformanceState = (passing: number, failing: number, total: number): ConformanceState => {
  const complete = total > 0 && Equal.equals(passing, total)

  if (failing > 0) return "failing"

  if (complete) return "exercised-scope-passes"

  return passing > 0 ? "partial" : "untested"
}

const conformanceSummary = (state: ConformanceState, scopes: ReadonlyArray<ScopeEvidence>) => {
  const total = Array.length(scopes)
  const passing = tallyOf(scopes)("pass")
  const counts = stateSummary(scopes)
  const unexercised = total > 0 ? `no current passing result (${counts})` : "no scenario exercises this requirement"

  return pipe(
    Match.value(state),
    Match.when("exercised-scope-passes", Function.constant(`all ${total} exercised scenario scope(s) pass on the current build; this covers only the declared scenarios and inputs`)),
    Match.when("failing", Function.constant(`${counts} on the current build`)),
    Match.when("partial", Function.constant(`${passing} of ${total} exercised scope(s) pass on the current build (${counts}); a passing subset is not completion`)),
    Match.orElse(Function.constant(unexercised)),
  )
}

/** Conformance never reports completion from a subset because only every exercised scope passing on the current build counts. */
export const conformanceOf = (scopes: ReadonlyArray<ScopeEvidence>) => {
  const total = Array.length(scopes)
  const passing = tallyOf(scopes)("pass")
  const failing = tallyOf(scopes)("fail")
  const state = conformanceState(passing, failing, total)
  const summary = conformanceSummary(state, scopes)

  return Conformance.make({ state, passing, scopes: total, summary })
}

/** One retained non-gating assessment as reported to consumers because benefit is read only from model assessments and their approval label. */
class RecordedAssessment extends Schema.Class<RecordedAssessment>("RecordedAssessment")({
  run: Schema.String,
  startedAt: Schema.String,
  scenario: Schema.String,
  requirement: Schema.String,
  status: ResultStatusSchema,
  label: Schema.String,
  level: OptionalTextSchema,
  unresolved: Schema.Boolean,
}) {}

const recordedAssessment = (entry: EvidenceRun) => (assessment: RetainedAssessment) => RecordedAssessment.make({
  run: entry.path,
  startedAt: entry.run.startedAt,
  scenario: assessment.result.scenario,
  requirement: assessment.result.requirement,
  status: assessment.result.status,
  label: approvalLabel(assessment.rubric.approval, assessment.requirementApproval),
  level: assessment.level,
  unresolved: unresolved(assessment.rubric.approval, assessment.requirementApproval, assessment.result.status),
})

const noAssessments = Array.empty<RetainedAssessment>()

const scenarioAssessments = (entry: EvidenceRun) => flow(Struct.get<RetainedScenario, "assessments">("assessments"), Option.getOrElse(Function.constant(noAssessments)), Array.map(recordedAssessment(entry)))

const assessmentsIn = (entry: EvidenceRun) => Array.flatMap(entry.run.scenarios, scenarioAssessments(entry))

const assessmentStart = Order.mapInput(Order.String, Struct.get<RecordedAssessment, "startedAt">("startedAt"))

const allAssessments = (product: Product) => pipe(product.runs, Array.flatMap(assessmentsIn), Array.sort(Order.flip(assessmentStart)))

const assessing = (product: Product, key: string) => (assessment: RecordedAssessment) => pipe(assessment.requirement, keyOf(product), sameText(key))

const isRated = (assessment: RecordedAssessment) => Option.isSome(assessment.level)

/** The newest rated assessment of a scenario wins over newer unrated ones because a model-free replay leaves the exploration's rating as the latest review. */
const latestOfScenario = (group: Array.NonEmptyReadonlyArray<RecordedAssessment>) => {
  const rated = Array.findFirst(group, isRated)
  const newest = Array.headNonEmpty(group)

  return Option.getOrElse(rated, Function.constant(newest))
}

const latestAssessments = (assessments: ReadonlyArray<RecordedAssessment>) => pipe(assessments, Array.groupBy(Struct.get("scenario")), Record.values, Array.map(latestOfScenario))

const levelText = (level: string) => ` (rated "${level}")`

const unresolvedText = (assessment: RecordedAssessment) => assessment.unresolved ? " [unresolved assessment]" : ""

const assessmentText = (assessment: RecordedAssessment) => {
  const rated = pipe(assessment.level, Option.map(levelText), Option.getOrElse(Function.constant("")))

  return `${assessment.label}: ${assessment.status}${rated} (${assessment.scenario}, ${assessment.run})${unresolvedText(assessment)}`
}

/** Validated user benefit stays "not assessed" unless a non-gating model assessment exists, and is then reported only under its approval label, because passing assertions establish conformance, never benefit. */
export const benefitOf = (assessments: ReadonlyArray<RecordedAssessment>) => {
  const lines = pipe(assessments, latestAssessments, Array.map(assessmentText))

  return Array.isReadonlyArrayNonEmpty(lines) ? Array.join(lines, "; ") : notAssessed
}

const notExecutable = Conformance.make({
  state: "untested",
  passing: 0,
  scopes: 0,
  summary: "not an executable obligation: a qualitative requirement is only rated by a non-gating model assessment, so tested conformance does not apply",
})

const assessedBy = (product: Product, key: string) => (scenario: Scenario) => pipe(scenario.assessments, Array.map(keyOf(product)), Array.contains(key))

const assessmentScenarios = (product: Product, key: string) => pipe(product.catalog.scenarios, Array.filter(assessedBy(product, key)), Array.map(Struct.get("id")))

const scenarioNamed = (product: Product) => (id: string) => Array.findFirst(product.catalog.scenarios, withId(id))

const scopeOperations = (product: Product) => (scopes: ReadonlyArray<ScopeEvidence>) => pipe(
  scopes,
  Array.map(flow(Struct.get("scope"), Struct.get("scenario"), scenarioNamed(product))),
  Array.getSomes,
  Array.flatMap(Struct.get("operations")),
  Array.dedupe,
)

const assessmentImplementation = (product: Product, requirement: Requirement, key: string) => {
  const scenarios = assessmentScenarios(product, key)
  const scenarioList = Array.isReadonlyArrayNonEmpty(scenarios) ? Array.join(scenarios, ", ") : "no scenario"
  const rubric = pipe(requirement.rubric, Option.getOrElse(Function.constant("no rubric")))
  const detail = `non-gating model assessment against rubric ${rubric} in ${scenarioList}; requirement ${requirement.approval}; never an executable obligation`

  return ImplementationStatus.make({ state: "assessment", detail })
}

const implementationOf = (product: Product, requirement: Requirement, scopes: ReadonlyArray<ScopeEvidence>, refinedBy: ReadonlyArray<string>) => {
  const evaluation = Option.all([requirement.evaluator, requirement.evaluatorRevision])
  const unexercised = Array.isReadonlyArrayEmpty(scopes)
  const operations = scopeOperations(product)(scopes)
  const operationList = Array.isReadonlyArrayNonEmpty(operations) ? Array.join(operations, ", ") : "no operation"
  const refiners = Array.isReadonlyArrayNonEmpty(refinedBy) ? `refined by ${Array.join(refinedBy, ", ")}` : "not refined in this application"

  const evaluated = ([evaluator, revision]: readonly [string, string]) => unexercised
    ? ImplementationStatus.make({ state: "no-scenario", detail: `evaluator ${evaluator}@${revision} is declared but no scenario exercises this requirement` })
    : ImplementationStatus.make({ state: "bound", detail: `evaluator ${evaluator}@${revision} is available; scenarios bind native operation(s) ${operationList}` })

  const unevaluated = ImplementationStatus.make({ state: "no-evaluator", detail: `shared or refinement-only obligation without an evaluator; ${refiners}` })

  return Option.match(evaluation, { onNone: Function.constant(unevaluated), onSome: evaluated })
}

const describeRefinement = (requirement: Requirement) => {
  const describeArguments = (entry: readonly [string, string]) => `${Tuple.get(entry, 0)}=${Tuple.get(entry, 1)}`
  const argumentsText = (refines: Requirement["refines"] extends Option.Option<infer A> ? A : never) => pipe(refines.arguments, Record.toEntries, Array.map(describeArguments), Array.join(", "))
  const text = (refines: Requirement["refines"] extends Option.Option<infer A> ? A : never) => `${refines.requirement} (${argumentsText(refines)})`

  return Option.map(requirement.refines, text)
}

const refinesKey = (product: Product, key: string) => (requirement: Requirement) => {
  const target = Option.map(requirement.refines, Struct.get("requirement"))

  return Option.exists(target, flow(keyOf(product), sameText(key)))
}

const refinersOf = (product: Product, key: string) => pipe(product.catalog.requirements, Array.filter(refinesKey(product, key)), Array.map(Struct.get("id")))

const scopeIn = (product: Product, key: string) => (evidence: ScopeEvidence) => pipe(evidence.scope.requirement, keyOf(product), sameText(key))

const storiesScoping = (product: Product, key: string) => pipe(product.catalog.stories, Array.filter(flow(Struct.get("requirements"), referencesKey(product, [key]))), Array.map(qualified))

const recordedTogether = fieldIs<RecordedResult, "run">("run")
const statusText = (result: RecordedResult) => `${result.scenario}=${result.status}`

/** Results arrive newest first, so the head of each build group is that build's latest run. */
const buildEvidence = (product: Product) => (inBuild: Array.NonEmptyReadonlyArray<RecordedResult>) => {
  const latest = Array.headNonEmpty(inBuild)
  const statuses = pipe(inBuild, Array.filter(recordedTogether(latest.run)), Array.map(statusText))
  const current = Equal.equals(latest.build, product.current.sha256)

  return BuildEvidence.make({ build: latest.build, current, run: latest.run, startedAt: latest.startedAt, statuses })
}

const buildsOf = (product: Product, scopes: ReadonlyArray<ScopeEvidence>) => {
  const results = pipe(scopes, Array.map(Struct.get("scope")), Array.flatMap(recordedFor(product)), Array.sort(newestFirst))
  const groups = pipe(results, Array.groupBy(Struct.get("build")), Record.values)

  return Array.map(groups, buildEvidence(product))
}

const requirementEntry = (product: Product, scopes: ReadonlyArray<ScopeEvidence>, owner: Catalog, reference: string) => (requirement: Requirement) => {
  const key = ownedKey(requirement.id)(owner)
  const own = Array.filter(scopes, scopeIn(product, key))
  const refinedBy = refinersOf(product, key)
  const evaluation = Option.all([requirement.evaluator, requirement.evaluatorRevision])
  const evaluator = Option.map(evaluation, Array.join("@"))
  const qualitative = isQualitative(requirement)
  const assessments = pipe(product, allAssessments, Array.filter(assessing(product, key)))
  const implementation = qualitative ? assessmentImplementation(product, requirement, key) : implementationOf(product, requirement, own, refinedBy)

  return RequirementEntry.make({
    reference,
    owner: qualified(owner),
    revision: requirement.revision,
    text: requirement.text,
    category: requirement.category,
    evaluator,
    refines: describeRefinement(requirement),
    refinedBy,
    stories: storiesScoping(product, key),
    scopes: own,
    builds: buildsOf(product, own),
    implementation,
    conformance: qualitative ? notExecutable : conformanceOf(own),
    benefit: benefitOf(assessments),
  })
}

const localEntry = (product: Product, scopes: ReadonlyArray<ScopeEvidence>) => (requirement: Requirement) => requirementEntry(product, scopes, product.catalog, requirement.id)(requirement)

const importedEntries = (product: Product, scopes: ReadonlyArray<ScopeEvidence>) => (entry: ImportedCatalog) => {
  const entryFor = (requirement: Requirement) => requirementEntry(product, scopes, entry.catalog, `${entry.alias}:${requirement.id}`)(requirement)

  return Array.map(entry.catalog.requirements, entryFor)
}

const matchesFilter = (filter: Option.Option<string>) => (entry: RequirementEntry) => {
  const unqualified = pipe(entry.reference, Text.split(":"), Array.last, Option.getOrElse(Function.constant(entry.reference)))
  const matches = (wanted: string) => Array.contains([entry.reference, unqualified], wanted)

  return Option.match(filter, { onNone: Function.constTrue, onSome: matches })
}

/** Requirement → stories, scenarios, evaluator@revision, and evidence per build, with implementation, conformance, and benefit kept apart. */
export const requirementView = (filter: Option.Option<string>) => (product: Product) => {
  const scopes = allScopes(product)
  const local = Array.map(product.catalog.requirements, localEntry(product, scopes))
  const imported = Array.flatMap(product.imports, importedEntries(product, scopes))
  const entries = pipe([...local, ...imported], Array.filter(matchesFilter(filter)))

  return RequirementView.make({ application: product.application, current: product.current, entries, unreadable: product.unreadable })
}

const fixtureText = (source: FixtureSource) => `fixture fact ${source.fact}[${source.offset}]`
const capturedText = (source: CapturedSource) => `captured ${source.field}[${source.offset}]`
const approvedText = (source: TextSource) => `approved text ${source.fixture}.${source.field}`
const literalText = (source: typeof LiteralSourceSchema.Type) => `literal ${JSON.stringify(source.value)}`
const nativeText = (source: typeof NativeSourceSchema.Type) => `native ${source.strategy}`

const describeSource = pipe(
  Match.type<FieldSource>(),
  Match.discriminatorsExhaustive("source")({ fixture: fixtureText, captured: capturedText, text: approvedText, literal: literalText, native: nativeText }),
)

const describeField = ([field, source]: readonly [string, FieldSource]) => {
  const described = describeSource(source)

  return `${field} ← ${described}`
}

const deniedText = (outcome: typeof DeniedSchema.Type) => `denied ${outcome.failure}`

const contendedText = (outcome: typeof ContendedSchema.Type) => `contended: accepted when it wins its race, otherwise denied ${Array.join(outcome.failures, " or ")}`

const describeOutcome = pipe(
  Match.type<InputCase["outcome"]>(),
  Match.discriminatorsExhaustive("kind")({ accepted: Function.constant("accepted"), rejected: Function.constant("rejected"), denied: deniedText, contended: contendedText }),
)

const inputSummary = (input: InputCase) => {
  const fields = pipe(input.fields, Record.toEntries, Array.map(describeField))
  const outcome = describeOutcome(input.outcome)

  return InputSummary.make({ id: input.id, validity: input.validity, outcome, fields })
}

const usesOperation = fieldIs<InputCase, "operation">("operation")
const listsOperation = (operation: string) => flow(Struct.get<Capability | Scenario, "operations">("operations"), Array.contains(operation))
const scopeOfScenario = (id: string) => (evidence: ScopeEvidence) => Equal.equals(evidence.scope.scenario, id)

const operationScenario = (scopes: ReadonlyArray<ScopeEvidence>, operation: string) => (scenario: Scenario) => {
  const inputs = pipe(scenario.inputs, Array.filter(usesOperation(operation)), Array.map(inputSummary))
  const own = Array.filter(scopes, scopeOfScenario(scenario.id))

  return OperationScenario.make({ scenario: qualified(scenario), story: scenario.story, inputs, scopes: own })
}

const describeRequirementReference = (product: Product) => (reference: string) => {
  const bound = Array.findFirst(product.requirements, boundAs(reference))
  const describe = (requirement: BoundRequirement) => `${reference}@${requirement.revision} via ${requirement.evaluator}@${requirement.evaluatorRevision}: ${requirement.text}`

  return pipe(bound, Option.map(describe), Option.getOrElse(Function.constant(reference)))
}

const featureOf = (product: Product) => (capability: string) => {
  const containing = (feature: Catalog["features"][number]) => Array.contains(feature.capabilities, capability)

  return Array.findFirst(product.catalog.features, containing)
}

const operationEntry = (product: Product, scopes: ReadonlyArray<ScopeEvidence>) => (operation: string) => {
  const capabilities = Array.filter(product.catalog.capabilities, listsOperation(operation))
  const capabilityIds = Array.map(capabilities, Struct.get("id"))
  const features = pipe(capabilityIds, Array.map(featureOf(product)), Array.getSomes, Array.map(qualified), Array.dedupe)
  const capabilityStory = (story: Catalog["stories"][number]) => Array.some(story.capabilities, amongst(capabilityIds))
  const stories = pipe(product.catalog.stories, Array.filter(capabilityStory), Array.map(qualified))
  const scenarios = Array.filter(product.catalog.scenarios, listsOperation(operation))
  const requirements = pipe(scenarios, Array.flatMap(Struct.get("requirements")), Array.dedupe, Array.map(describeRequirementReference(product)))

  return OperationEntry.make({
    operation,
    native: Array.contains(product.operations, operation),
    capabilities: Array.map(capabilities, qualified),
    features,
    stories,
    requirements,
    scenarios: Array.map(scenarios, operationScenario(scopes, operation)),
  })
}

/** The implementation-agent consumer: which capabilities, requirements, scenarios, and inputs bind an operation, with their evidence state. */
export const implementationView = (operation: Option.Option<string>) => (product: Product) => {
  const declared = Array.flatMap(product.catalog.capabilities, Struct.get("operations"))
  const known = pipe([...product.operations, ...declared], Array.dedupe)
  const operations = Option.match(operation, { onNone: Function.constant(known), onSome: Array.of })
  const scopes = allScopes(product)
  const entries = Array.map(operations, operationEntry(product, scopes))

  return ImplementationView.make({ application: product.application, current: product.current, operations: entries })
}

const scopeReason = (evidence: ScopeEvidence) => {
  const run = pipe(evidence.latest, Option.map(Struct.get("run")), Option.getOrElse(Function.constant("no run")))
  const staleness = pipe(evidence.latest, Option.map(flow(Struct.get("staleness"), Array.join("; "))), Option.getOrElse(Function.constant("")))

  return pipe(
    Match.value(evidence.state),
    Match.when("missing", Function.constant("missing: no retained result")),
    Match.when("stale", Function.constant(`stale: ${staleness} (newest ${run})`)),
    Match.orElse(Function.constant(`${evidence.state} on the current build (${run})`)),
  )
}

const reasonEntry = (evidence: ScopeEvidence) => {
  const reason = scopeReason(evidence)

  return Tuple.make(reason, evidence.scope.requirement)
}

const groupedReason = (entry: readonly [string, Array.NonEmptyReadonlyArray<readonly [string, string]>]) => {
  const [reason, members] = entry
  const requirements = pipe(members, Array.map(Tuple.get(1)), Array.join(", "))

  return `${reason} [${requirements}]`
}

const reasonsOf = (scopes: ReadonlyArray<ScopeEvidence>) => {
  const entries = Array.map(scopes, reasonEntry)
  const grouped = Array.groupBy(entries, Tuple.get(0))

  return pipe(grouped, Record.toEntries, Array.map(groupedReason))
}

const qaScenario = (scopes: ReadonlyArray<ScopeEvidence>, states: ReadonlyArray<ScopeState>) => (scenario: Scenario) => {
  const own = Array.filter(scopes, scopeOfScenario(scenario.id))
  const flagged = Array.filter(own, flow(Struct.get("state"), amongst(states)))
  const entry = QaScenario.make({ scenario: qualified(scenario), story: scenario.story, reasons: reasonsOf(flagged), scopes: own })

  return Array.isReadonlyArrayNonEmpty(flagged) ? Option.some(entry) : Option.none()
}

const passesEverything = (scopes: ReadonlyArray<ScopeEvidence>) => (scenario: Scenario) => {
  const own = Array.filter(scopes, scopeOfScenario(scenario.id))
  const nonEmpty = Array.isReadonlyArrayNonEmpty(own)

  return nonEmpty && Array.every(own, inState("pass"))
}

const scenarioAssessmentLine = (product: Product, assessments: ReadonlyArray<RecordedAssessment>, scenario: Scenario) => (reference: string) => {
  const key = keyOf(product)(reference)
  const ofScenario = (assessment: RecordedAssessment) => Equal.equals(assessment.scenario, scenario.id)
  const own = pipe(assessments, Array.filter(assessing(product, key)), Array.filter(ofScenario), latestAssessments, Array.head)
  const assessed = Option.map(own, assessmentText)

  return `${qualified(scenario)} assesses ${reference}: ${Option.getOrElse(assessed, Function.constant("not yet assessed [unresolved assessment]"))}`
}

const scenarioAssessmentLines = (product: Product, assessments: ReadonlyArray<RecordedAssessment>) => (scenario: Scenario) => Array.map(scenario.assessments, scenarioAssessmentLine(product, assessments, scenario))

/** QA consumer: scenarios needing a run for the current build (missing, stale, blocked, inconclusive) and those failing on it, with non-gating assessments listed apart. */
export const qaView = (product: Product) => {
  const scopes = allScopes(product)
  const { scenarios } = product.catalog
  const needingRun = pipe(scenarios, Array.map(qaScenario(scopes, needsRunStates)), Array.getSomes)
  const failing = pipe(scenarios, Array.map(qaScenario(scopes, ["fail"])), Array.getSomes)
  const passing = pipe(scenarios, Array.filter(passesEverything(scopes)), Array.length)
  const total = Array.length(scenarios)
  const pending = Array.length(needingRun)
  const failures = Array.length(failing)
  const recorded = allAssessments(product)
  const assessments = Array.flatMap(scenarios, scenarioAssessmentLines(product, recorded))
  const summary = `${passing} of ${total} scenario(s) pass every bound requirement on the current build ${short(product.current.sha256)}; ${pending} need a run and ${failures} fail. Passing scenarios are tested conformance in their declared scope only, not completion and not validated user benefit; non-gating model assessments are listed separately and never counted.`

  return QaView.make({ application: product.application, current: product.current, needingRun, failing, passing, scenarios: total, summary, assessments, unreadable: product.unreadable })
}

const capabilityText = (product: Product) => (id: string) => {
  const capability = Array.findFirst(product.catalog.capabilities, withId(id))
  const feature = pipe(id, featureOf(product), Option.map(Struct.get("title")), Option.getOrElse(Function.constant("no feature")))
  const describe = (entry: Catalog["capabilities"][number]) => `${qualified(entry)} in feature "${feature}": ${entry.resource} via ${Array.join(entry.operations, ", ")}`

  return pipe(capability, Option.map(describe), Option.getOrElse(Function.constant(id)))
}

const requirementText = (product: Product, entries: ReadonlyArray<RequirementEntry>) => (reference: string) => {
  const key = keyOf(product)(reference)
  const entryKey = flow(Struct.get<RequirementEntry, "reference">("reference"), keyOf(product))
  const found = Array.findFirst(entries, flow(entryKey, sameText(key)))
  const describe = (entry: RequirementEntry) => `${reference}@${entry.revision}: ${entry.text} [conformance: ${entry.conformance.state}; user benefit: ${entry.benefit}]`

  return pipe(found, Option.map(describe), Option.getOrElse(Function.constant(reference)))
}

const scenarioText = (scopes: ReadonlyArray<ScopeEvidence>) => (scenario: Scenario) => {
  const own = Array.filter(scopes, scopeOfScenario(scenario.id))

  return `${qualified(scenario)}: ${scenario.goal} [${stateSummary(own)}]`
}

const storyOf = fieldIs<Scenario, "story">("story")

const journeyStory = (product: Product, entries: ReadonlyArray<RequirementEntry>, scopes: ReadonlyArray<ScopeEvidence>) => (story: Catalog["stories"][number]) => {
  const context = pipe(product.catalog.contexts, Array.findFirst(withId(story.context)), Option.map(Struct.get("narrative")), Option.getOrElse(Function.constant(story.context)))
  const need = pipe(product.catalog.needs, Array.findFirst(withId(story.need)), Option.map(Struct.get("text")), Option.getOrElse(Function.constant(story.need)))
  const scenarios = Array.filter(product.catalog.scenarios, storyOf(story.id))

  return JourneyStory.make({
    story: qualified(story),
    original: story.original,
    context: `${story.context}: ${context}`,
    need: `${story.need}: ${need}`,
    capabilities: Array.map(story.capabilities, capabilityText(product)),
    requirements: Array.map(story.requirements, requirementText(product, entries)),
    scenarios: Array.map(scenarios, scenarioText(scopes)),
    nonGoals: story.nonGoals,
  })
}

const actedBy = (id: string) => (story: Catalog["stories"][number]) => Equal.equals(story.actor, id)

const journey = (product: Product, entries: ReadonlyArray<RequirementEntry>, scopes: ReadonlyArray<ScopeEvidence>) => (actor: Catalog["actors"][number]) => {
  const stories = pipe(product.catalog.stories, Array.filter(actedBy(actor.id)), Array.map(journeyStory(product, entries, scopes)))

  return Journey.make({ actor: qualified(actor), description: actor.description, stories })
}

/** Documentation consumer: role-centred journeys read from the executed catalog because a second documentation catalog would drift. */
export const documentationView = (product: Product) => {
  const scopes = allScopes(product)
  const unfiltered = Option.none<string>()
  const { entries } = requirementView(unfiltered)(product)
  const journeys = Array.map(product.catalog.actors, journey(product, entries, scopes))

  return DocumentationView.make({ application: product.application, title: product.title, current: product.current, journeys })
}

const describeLocalRefinement = (requirement: Requirement) => {
  const refinement = describeRefinement(requirement)
  const prefixed = (text: string) => `${qualified(requirement)} refines ${text}`

  return Option.map(refinement, prefixed)
}

const scenarioReferences = (scenario: Scenario) => [...scenario.requirements, ...scenario.assessments]

const referencedKeys = (product: Product) => pipe(product.catalog.scenarios, Array.flatMap(scenarioReferences), Array.map(keyOf(product)))

const refinedKeys = (product: Product) => pipe(product.catalog.requirements, Array.flatMap(flow(Struct.get("refines"), Option.toArray)), Array.map(flow(Struct.get("requirement"), keyOf(product))))

const unrefinedIn = (product: Product, covered: ReadonlyArray<string>) => (entry: ImportedCatalog) => {
  const uncovered = (requirement: Requirement) => {
    const key = ownedKey(requirement.id)(entry.catalog)

    return !Array.contains(covered, key)
  }

  const describe = (requirement: Requirement) => `${entry.alias}:${qualified(requirement)} (${entry.catalog.id}) is neither refined nor exercised by ${product.application}`

  return pipe(entry.catalog.requirements, Array.filter(uncovered), Array.map(describe))
}

const unlinked = <A extends Revision>(declarations: ReadonlyArray<A>, linked: ReadonlyArray<string>) => pipe(declarations, Array.filter(flow(Struct.get("id"), Predicate.not(amongst(linked)))), Array.map(qualified))

export const partitionScope = "declared-vocabulary coverage; not exhaustiveness"

class LabeledInput extends Schema.Class<LabeledInput>("LabeledInput")({
  label: Schema.String,
  input: InputCase,
}) {}

const labeledIn = (scenario: Scenario) => (input: InputCase) => LabeledInput.make({ label: `${scenario.id}/${input.id}`, input })

const scenarioInputs = (operation: string) => (scenario: Scenario) => pipe(scenario.inputs, Array.filter(usesOperation(operation)), Array.map(labeledIn(scenario)))

const labeledInputs = (product: Product, operation: string) => Array.flatMap(product.catalog.scenarios, scenarioInputs(operation))

const byFieldName = Order.mapInput(Order.String, Struct.get<readonly [string, FieldSource], 0>(0))

const sourcesKey = (entry: LabeledInput) => pipe(entry.input.fields, Record.toEntries, Array.sort(byFieldName), Array.map(describeField), Array.join("; "))

const isOverlap = ([, group]: readonly [string, Array.NonEmptyReadonlyArray<LabeledInput>]) => Array.length(group) > 1

const overlapText = ([key, group]: readonly [string, Array.NonEmptyReadonlyArray<LabeledInput>]) => {
  const labels = pipe(group, Array.map(Struct.get("label")), Array.join(", "))
  const sources = Text.isEmpty(key) ? "no fields" : key

  return `${labels} declare identical sources (${sources})`
}

const isLiteral = Schema.is(LiteralSourceSchema)
const isNative = Schema.is(NativeSourceSchema)
const literalJson = (source: typeof LiteralSourceSchema.Type) => JSON.stringify(source.value)

const literalsOf = (field: string) => (entry: LabeledInput) => pipe(entry.input.fields, Record.get(field), Option.filter(isLiteral), Option.map(literalJson), Option.toArray)

const strategiesOf = (field: string) => (entry: LabeledInput) => pipe(entry.input.fields, Record.get(field), Option.filter(isNative), Option.map(Struct.get("strategy")), Option.toArray)

const listedOrNone = (values: ReadonlyArray<string>) => Array.isReadonlyArrayEmpty(values) ? "none" : Array.join(values, ", ")

const problemText = (condition: boolean, text: string) => condition ? Array.of(text) : Array.empty<string>()

// Only fields some input feeds a literal are judged because an enumerated field fed by fixtures, captures, or samples has no declared member choice.
const memberGap = (inputs: ReadonlyArray<LabeledInput>) => (native: NativeField): ReadonlyArray<string> => {
  const exercised = pipe(inputs, Array.flatMap(literalsOf(native.field)), Array.dedupe)
  const missing = Array.filter(native.members, Predicate.not(amongst(exercised)))
  const judged = Array.isReadonlyArrayNonEmpty(exercised)
  const gap = Array.isReadonlyArrayNonEmpty(missing)
  const missingList = Array.join(missing, ", ")
  const exercisedList = Array.join(exercised, ", ")
  const reported = judged && gap

  return problemText(reported, `${native.field}: ${missingList} never exercised (exercised: ${exercisedList})`)
}

const boundaryCoverage = (inputs: ReadonlyArray<LabeledInput>) => (native: NativeField) => {
  const exercised = pipe(inputs, Array.flatMap(strategiesOf(native.field)), Array.dedupe)
  const missing = Array.filter(native.strategies, Predicate.not(amongst(exercised)))
  const applicable = Array.join(native.strategies, ", ")
  const exercisedList = listedOrNone(exercised)
  const missingList = listedOrNone(missing)

  return `${native.field} (applicable ${applicable}): exercised native ${exercisedList}; boundary strategies never exercised: ${missingList}`
}

const ofOperation = fieldIs<NativeField, "operation">("operation")
const enumerated = flow(Struct.get<NativeField, "members">("members"), Array.isReadonlyArrayNonEmpty)
const bounded = flow(Struct.get<NativeField, "strategies">("strategies"), Array.isReadonlyArrayNonEmpty)

/** Overlaps, unexercised enum members, and boundary strategies of one operation because a scenario partition is only checkable within the declared vocabulary. */
const partitionOf = (product: Product) => (operation: string) => {
  const inputs = labeledInputs(product, operation)
  const fields = Array.filter(product.fields, ofOperation(operation))
  const overlaps = pipe(inputs, Array.groupBy(sourcesKey), Record.toEntries, Array.filter(isOverlap), Array.map(overlapText))
  const unexercisedMembers = pipe(fields, Array.filter(enumerated), Array.flatMap(memberGap(inputs)))
  const boundaries = pipe(fields, Array.filter(bounded), Array.map(boundaryCoverage(inputs)))

  return PartitionCoverage.make({ operation, inputCases: Array.length(inputs), overlaps, unexercisedMembers, boundaries })
}

/** Gap consumer: unlinked capabilities, needs, requirements, stories, and operations, how shared obligations are refined, and declared-vocabulary partition coverage. */
export const gapView = (product: Product) => {
  const { catalog } = product
  const storyCapabilities = Array.flatMap(catalog.stories, Struct.get("capabilities"))
  const capabilitiesWithoutNeed = unlinked(catalog.capabilities, storyCapabilities)
  const linkedStory = (story: Catalog["stories"][number]) => Array.isReadonlyArrayNonEmpty(story.capabilities)
  const linkedNeeds = pipe(catalog.stories, Array.filter(linkedStory), Array.map(Struct.get("need")))
  const needsWithoutCapabilities = unlinked(catalog.needs, linkedNeeds)
  const referenced = referencedKeys(product)
  const unexercised = flow(Struct.get<Requirement, "id">("id"), ownedKey, Function.apply(catalog), Predicate.not(amongst(referenced)))
  const requirementsWithoutScenarios = pipe(catalog.requirements, Array.filter(unexercised), Array.map(qualified))
  const scenarioStories = Array.map(catalog.scenarios, Struct.get("story"))
  const storiesWithoutScenarios = unlinked(catalog.stories, scenarioStories)
  const boundOperations = Array.flatMap(catalog.capabilities, Struct.get("operations"))
  const operationsWithoutCapability = Array.filter(product.operations, Predicate.not(amongst(boundOperations)))
  const refinements = pipe(catalog.requirements, Array.map(describeLocalRefinement), Array.getSomes)
  const covered = [...referenced, ...refinedKeys(product)]
  const unrefinedShared = Array.flatMap(product.imports, unrefinedIn(product, covered))
  const partitions = Array.map(product.operations, partitionOf(product))

  return GapView.make({
    application: product.application,
    capabilitiesWithoutNeed,
    needsWithoutCapabilities,
    requirementsWithoutScenarios,
    storiesWithoutScenarios,
    operationsWithoutCapability,
    refinements,
    unrefinedShared,
    partitionScope,
    partitions,
  })
}

class ImpactPart extends Schema.Class<ImpactPart>("ImpactPart")({
  matches: TextsSchema,
  declarations: TextsSchema,
  scenarios: TextsSchema,
}) {}

const noImpact = ImpactPart.make({ matches: [], declarations: [], scenarios: [] })

const declared = (kind: string) => (declaration: Revision) => `${kind} ${qualified(declaration)}`

const scenariosOfStories = (product: Product, stories: ReadonlyArray<string>) => pipe(product.catalog.scenarios, Array.filter(flow(Struct.get("story"), amongst(stories))), Array.map(Struct.get("id")))

type StoryDeclaration = Catalog["stories"][number]

const throughStories = (product: Product, kind: string, extra: ReadonlyArray<string>) => (stories: ReadonlyArray<StoryDeclaration>) => (entry: Revision) => {
  const match = declared(kind)(entry)
  const ids = Array.map(stories, Struct.get("id"))
  const storyDeclarations = Array.map(stories, declared("story"))

  return ImpactPart.make({ matches: [match], declarations: [...extra, ...storyDeclarations], scenarios: scenariosOfStories(product, ids) })
}

const storiesWhere = (product: Product, predicate: (story: StoryDeclaration) => boolean) => Array.filter(product.catalog.stories, predicate)

const inContext = (id: string) => (story: StoryDeclaration) => Equal.equals(story.context, id)
const forNeed = (id: string) => (story: StoryDeclaration) => Equal.equals(story.need, id)
const usesCapability = (id: string) => flow(Struct.get<StoryDeclaration, "capabilities">("capabilities"), Array.contains(id))

/** Actors, contexts, and needs reach scenarios only through the stories that name them because scenarios inherit them from their story. */
const viaStories = (kind: string, declarations: (catalog: Catalog) => ReadonlyArray<Revision>, selects: (id: string) => (story: StoryDeclaration) => boolean) => (product: Product, changed: string) => {
  const found = pipe(product.catalog, declarations, Array.findFirst(withId(changed)))
  const selected = selects(changed)
  const stories = storiesWhere(product, selected)
  const features = pipe(changed, featureOf(product), Option.toArray, Array.map(declared("feature")))
  const impact = throughStories(product, kind, features)(stories)

  return Option.map(found, impact)
}

const actorImpact = viaStories("actor", Struct.get("actors"), actedBy)
const contextImpact = viaStories("context", Struct.get("contexts"), inContext)
const needImpact = viaStories("need", Struct.get("needs"), forNeed)
const capabilityImpact = viaStories("capability", Struct.get("capabilities"), usesCapability)

/** A feature only groups capabilities because product structure is not an executed obligation, so its dependents are documented stories only. */
const featureImpact = (product: Product, changed: string) => {
  const feature = Array.findFirst(product.catalog.features, withId(changed))

  const impact = (entry: Catalog["features"][number]) => {
    const grouped = (story: StoryDeclaration) => Array.some(story.capabilities, amongst(entry.capabilities))
    const stories = pipe(product.catalog.stories, Array.filter(grouped), Array.map(declared("documented story")))
    const match = declared("feature")(entry)

    return ImpactPart.make({ matches: [match], declarations: stories, scenarios: [] })
  }

  return Option.map(feature, impact)
}

const isTextSource = Schema.is(TextSourceSchema)

const textFieldFrom = (fixture: string) => (source: FieldSource) => isTextSource(source) && Equal.equals(source.fixture, fixture)

const inputReadsText = (fixture: string) => (input: InputCase) => pipe(input.fields, Record.values, Array.some(textFieldFrom(fixture)))

const scenarioReadsText = (fixture: string) => (scenario: Scenario) => Array.some(scenario.inputs, inputReadsText(fixture))

const textFixtureImpact = (product: Product, changed: string) => {
  const fixture = Array.findFirst(product.catalog.textFixtures, withId(changed))
  const scenarios = pipe(product.catalog.scenarios, Array.filter(scenarioReadsText(changed)), Array.map(Struct.get("id")))
  const impact = (entry: Revision) => ImpactPart.make({ matches: [declared("text fixture")(entry)], declarations: [], scenarios })

  return Option.map(fixture, impact)
}

const keyReferenced = (product: Product, keys: ReadonlyArray<string>) => flow(Struct.get<Scenario, "requirements">("requirements"), referencesKey(product, keys))

const storyReferences = (product: Product, keys: ReadonlyArray<string>) => flow(Struct.get<StoryDeclaration, "requirements">("requirements"), referencesKey(product, keys))

const refinerKeys = (product: Product) => (key: string) => pipe(refinersOf(product, key), Array.map(flow(ownedKey, Function.apply(product.catalog))))

/** Follows recorded refinements transitively because a changed shared obligation reaches every requirement that refines it. */
const refinementClosures = (product: Product, keys: ReadonlyArray<string>): ReadonlyArray<string> => {
  const next = pipe(keys, Array.flatMap(refinerKeys(product)), Array.dedupe, Array.filter(Predicate.not(amongst(keys))))

  return Array.isReadonlyArrayEmpty(next) ? keys : refinementClosures(product, [...keys, ...next])
}

const requirementDeclarations = (product: Product, keys: ReadonlyArray<string>) => {
  const local = flow(Struct.get<Requirement, "id">("id"), ownedKey, Function.apply(product.catalog), amongst(keys))
  const requirements = pipe(product.catalog.requirements, Array.filter(local), Array.map(declared("requirement")))
  const stories = pipe(product.catalog.stories, Array.filter(storyReferences(product, keys)), Array.map(declared("story")))

  return [...requirements, ...stories]
}

const requirementImpactFor = (product: Product, key: string) => (match: string) => {
  const keys = refinementClosures(product, [key])
  const scenarios = pipe(product.catalog.scenarios, Array.filter(keyReferenced(product, keys)), Array.map(Struct.get("id")))

  return ImpactPart.make({ matches: [match], declarations: requirementDeclarations(product, keys), scenarios })
}

const localRequirementImpact = (product: Product, changed: string) => {
  const requirement = Array.findFirst(product.catalog.requirements, withId(changed))

  const impact = (entry: Requirement) => {
    const key = ownedKey(entry.id)(product.catalog)
    const match = declared("requirement")(entry)

    return requirementImpactFor(product, key)(match)
  }

  return Option.map(requirement, impact)
}

const importedRequirementImpact = (product: Product, changed: string) => {
  const key = keyOf(product)(changed)
  const ownedBy = (entry: ImportedCatalog) => Text.startsWith(`${entry.catalog.id}/`)(key)
  const provider = Array.findFirst(product.imports, ownedBy)
  const id = pipe(key, Text.split("/"), Array.last, Option.getOrElse(Function.constant(changed)))
  const local = Array.some(product.catalog.requirements, withId(changed))
  const describe = (entry: ImportedCatalog) => `shared requirement ${entry.alias}:${id} (${qualified(entry.catalog)})`
  const impact = flow(describe, requirementImpactFor(product, key))

  return local ? Option.none() : Option.map(provider, impact)
}

const storyImpact = (product: Product, changed: string) => {
  const story = Array.findFirst(product.catalog.stories, withId(changed))
  const impact = (entry: StoryDeclaration) => ImpactPart.make({ matches: [declared("story")(entry)], declarations: [], scenarios: scenariosOfStories(product, [entry.id]) })

  return Option.map(story, impact)
}

const scenarioImpact = (product: Product, changed: string) => {
  const scenario = Array.findFirst(product.catalog.scenarios, withId(changed))
  const impact = (entry: Scenario) => ImpactPart.make({ matches: [declared("scenario")(entry)], declarations: [], scenarios: [entry.id] })

  return Option.map(scenario, impact)
}

const importedCatalogImpact = (product: Product, changed: string) => {
  const imported = Array.findFirst(product.imports, flow(Struct.get("catalog"), withId(changed)))

  const impact = (entry: ImportedCatalog) => {
    const keys = pipe(entry.catalog.requirements, Array.map(flow(Struct.get("id"), ownedKey, Function.apply(entry.catalog))))
    const closure = refinementClosures(product, keys)
    const scenarios = pipe(product.catalog.scenarios, Array.filter(keyReferenced(product, closure)), Array.map(Struct.get("id")))
    const match = `imported catalog ${entry.alias} (${qualified(entry.catalog)})`

    return ImpactPart.make({ matches: [match], declarations: requirementDeclarations(product, closure), scenarios })
  }

  return Option.map(imported, impact)
}

const catalogImpact = (product: Product, changed: string) => {
  const same = Equal.equals(product.catalog.id, changed)
  const scenarios = Array.map(product.catalog.scenarios, Struct.get("id"))
  const impact = ImpactPart.make({ matches: [declared("catalog")(product.catalog)], declarations: [], scenarios })

  return same ? Option.some(impact) : Option.none()
}

const operationImpact = (product: Product, changed: string) => {
  const capabilities = Array.filter(product.catalog.capabilities, listsOperation(changed))
  const scenarios = Array.filter(product.catalog.scenarios, listsOperation(changed))
  const native = Array.contains(product.operations, changed)
  const bound = Array.isReadonlyArrayNonEmpty(capabilities)
  const known = native || bound
  const capabilityIds = Array.map(capabilities, Struct.get("id"))
  const capabilityStory = (story: StoryDeclaration) => Array.some(story.capabilities, amongst(capabilityIds))
  const stories = storiesWhere(product, capabilityStory)
  const inputLabel = (scenario: Scenario) => (input: string) => `input ${scenario.id}/${input}`
  const inputsOf = (scenario: Scenario) => pipe(scenario.inputs, Array.filter(usesOperation(changed)), Array.map(flow(Struct.get("id"), inputLabel(scenario))))
  const inputs = Array.flatMap(scenarios, inputsOf)
  const declarations = [...Array.map(capabilities, declared("capability")), ...Array.map(stories, declared("story")), ...inputs]
  const label = native ? `native operation ${changed}` : `operation ${changed} (not in the native contract)`
  const impact = ImpactPart.make({ matches: [label], declarations, scenarios: Array.map(scenarios, Struct.get("id")) })

  return known ? Option.some(impact) : Option.none()
}

const evaluatedBy = (evaluator: string) => (requirement: Requirement) => Option.contains(requirement.evaluator, evaluator)

const evaluatorImpact = (product: Product, changed: string) => {
  const requirements = Array.filter(product.catalog.requirements, evaluatedBy(changed))
  const keys = pipe(requirements, Array.map(flow(Struct.get("id"), ownedKey, Function.apply(product.catalog))))
  const closure = refinementClosures(product, keys)
  const scenarios = pipe(product.catalog.scenarios, Array.filter(keyReferenced(product, closure)), Array.map(Struct.get("id")))
  const revision = pipe(product.evaluators, Record.get(changed), Option.getOrElse(Function.constant("unbound")))
  const label = `evaluator ${changed}@${revision}`
  const impact = ImpactPart.make({ matches: [label], declarations: requirementDeclarations(product, closure), scenarios })
  const known = Array.isReadonlyArrayNonEmpty(requirements)

  return known ? Option.some(impact) : Option.none()
}

const fixtureImpact = (product: Product, changed: string) => {
  const admits = (context: Catalog["contexts"][number]) => Array.contains(context.fixtures, changed)
  const usesFixture = (scenario: Scenario) => Equal.equals(scenario.fixture, changed)
  const contexts = Array.filter(product.catalog.contexts, admits)
  const scenarios = pipe(product.catalog.scenarios, Array.filter(usesFixture), Array.map(Struct.get("id")))
  const impact = ImpactPart.make({ matches: [`fixture binding ${changed}`], declarations: Array.map(contexts, declared("context")), scenarios })
  const known = Array.isReadonlyArrayNonEmpty(contexts)

  return known ? Option.some(impact) : Option.none()
}

const impactSources: ReadonlyArray<(product: Product, changed: string) => Option.Option<ImpactPart>> = [
  catalogImpact,
  importedCatalogImpact,
  actorImpact,
  contextImpact,
  needImpact,
  capabilityImpact,
  featureImpact,
  textFixtureImpact,
  localRequirementImpact,
  importedRequirementImpact,
  storyImpact,
  scenarioImpact,
  operationImpact,
  evaluatorImpact,
  fixtureImpact,
]

const applySource = (product: Product, changed: string) => (source: (product: Product, changed: string) => Option.Option<ImpactPart>) => source(product, changed)

const combine = (parts: ReadonlyArray<ImpactPart>) => ImpactPart.make({
  matches: Array.flatMap(parts, Struct.get("matches")),
  declarations: pipe(parts, Array.flatMap(Struct.get("declarations")), Array.dedupe),
  scenarios: pipe(parts, Array.flatMap(Struct.get("scenarios")), Array.dedupe),
})

const scenarioIn = (scenarios: ReadonlyArray<string>) => (entry: RetainedScenario) => Array.contains(scenarios, entry.scenario.id)

const runCandidate = (product: Product, scenarios: ReadonlyArray<string>) => (entry: EvidenceRun) => {
  const covered = pipe(entry.run.scenarios, Array.filter(scenarioIn(scenarios)), Array.map(flow(Struct.get("scenario"), Struct.get("id"))))
  const current = Equal.equals(entry.run.build.sha256, product.current.sha256)
  const build = short(entry.run.build.sha256)
  const buildText = current ? `current build ${build}` : `build ${build}`
  const coveredText = Array.join(covered, ", ")
  const candidate = `${entry.path} (${buildText}, ${entry.run.startedAt}): ${coveredText}`

  return Array.isReadonlyArrayNonEmpty(covered) ? Option.some(candidate) : Option.none()
}

/** Change impact lists recorded dependents as candidates because unrecorded cross-feature effects can exist and an empty answer is never "no impact". */
export const impactView = (changed: string) => (product: Product) => {
  const parts = pipe(impactSources, Array.map(applySource(product, changed)), Array.getSomes)
  const combined = Array.isReadonlyArrayNonEmpty(parts) ? combine(parts) : noImpact
  const runs = pipe(product.runs, Array.map(runCandidate(product, combined.scenarios)), Array.getSomes)

  return ImpactView.make({
    application: product.application,
    changed,
    matches: combined.matches,
    declarations: combined.declarations,
    scenarios: combined.scenarios,
    runs,
    caveat: impactCaveat,
  })
}
