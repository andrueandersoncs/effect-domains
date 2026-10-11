import { Array, Effect, Equal, Function, Match, Option, Predicate, Record, Result, Schema, SchemaAST, String as Text, Struct, Tuple, flow, pipe } from "effect"
import type { ApplicationIR } from "effect-domains/application"

import {
  AcceptanceError,
  BoundRequirement,
  Catalog,
  ContendedSchema,
  DeniedSchema,
  type LiteralSourceSchema,
  type NativeSourceSchema,
  Requirement,
  Rubric,
  type ApprovalRecord,
  type CatalogImport,
  type Concurrency,
  type Feature,
  type FieldSource,
  type FixtureSource,
  InputCase,
  type ProductContext,
  type Refinement,
  type Revision,
  type Scenario,
  type TextSource,
  type Watch,
} from "./model.ts"

import { isQualitative, rubricAssessment, rubricAssessmentRevision } from "./assessment.ts"
import { literalProblem, nativeStrategyProblem } from "./inputs.ts"

const EvaluatorRevisionsSchema = Schema.Record(Schema.String, Schema.String)
const NamesSchema = Schema.Array(Schema.String)
const DeclarationSchema = Schema.toEncoded(Catalog)
const DeclarationsSchema = Schema.Array(DeclarationSchema)

type Declaration = typeof DeclarationSchema.Type

/** Importable catalogs are supplied explicitly because a reference may resolve only against a known registry, never by discovery. */
export class CatalogBindings extends Schema.Class<CatalogBindings>("CatalogBindings")({
  evaluators: EvaluatorRevisionsSchema,
  fixtures: NamesSchema,
  actors: NamesSchema,
  facts: NamesSchema,
  probes: NamesSchema,
  catalogs: DeclarationsSchema,
}) {}

const BoundRequirementsSchema = Schema.Array(BoundRequirement)

/** A resolved non-gating assessment because the runner must rate exactly the requirement and rubric revision validation resolved. */
export class BoundAssessment extends Schema.Class<BoundAssessment>("BoundAssessment")({
  reference: Schema.String,
  requirement: Requirement,
  rubric: Rubric,
}) {}

const BoundAssessmentsSchema = Schema.Array(BoundAssessment)

/** The validated catalog carries its bound obligations and assessments because execution must judge exactly the references validation resolved. */
export class ValidatedCatalog extends Schema.Class<ValidatedCatalog>("ValidatedCatalog")({
  catalog: Catalog,
  requirements: BoundRequirementsSchema,
  assessments: BoundAssessmentsSchema,
}) {}

class ImportedCatalog extends Schema.Class<ImportedCatalog>("ImportedCatalog")({
  alias: Schema.String,
  catalog: Catalog,
}) {}

const ImportedCatalogsSchema = Schema.Array(ImportedCatalog)
const ProblemsSchema = Schema.Array(Schema.String)
const OptionalImportedSchema = Schema.OptionFromOptionalKey(ImportedCatalog)

class ReferenceScope extends Schema.Class<ReferenceScope>("ReferenceScope")({
  catalog: Catalog,
  imports: ImportedCatalogsSchema,
}) {}

class CheckedDeclaration extends Schema.Class<CheckedDeclaration>("CheckedDeclaration")({
  scope: ReferenceScope,
  problems: ProblemsSchema,
}) {}

class ImportCheck extends Schema.Class<ImportCheck>("ImportCheck")({
  imported: OptionalImportedSchema,
  problems: ProblemsSchema,
}) {}

class ResolvedRequirement extends Schema.Class<ResolvedRequirement>("ResolvedRequirement")({
  reference: Schema.String,
  owner: Schema.String,
  requirement: Requirement,
}) {}

export type NativeOperation = NonNullable<ReturnType<ApplicationIR["group"]["requests"]["get"]>>

export const nativeOperations = (application: ApplicationIR): ReadonlyArray<NativeOperation> => pipe(application.group.requests.values(), Array.fromIterable)

const operationNames = (application: ApplicationIR) => pipe(application, nativeOperations, Array.map(Struct.get("_tag")))
const resourceNames = (application: ApplicationIR) => Array.map(application.resources, Struct.get("name"))
export const operationIn = (application: ApplicationIR) => (name: string): boolean => pipe(application, operationNames, Array.contains(name))
const resourceIn = (application: ApplicationIR) => (name: string): boolean => pipe(application, resourceNames, Array.contains(name))
const byId = (id: string) => (declaration: Revision) => Equal.equals(declaration.id, id)
const byAlias = (alias: string) => (entry: ImportedCatalog) => Equal.equals(entry.alias, alias)
export const amongst = (values: ReadonlyArray<string>) => (value: string): boolean => Array.contains(values, value)
const isRepeated = (group: Array.NonEmptyReadonlyArray<unknown>) => Array.length(group) > 1
export const problemIf = (condition: boolean, message: string) => condition ? Array.of(message) : Array.empty<string>()
const duplicateProblem = (id: string) => `Duplicate declaration id: ${id}`
const operationProblem = (operation: string) => `Missing native operation ${operation}`
const qualifiedName = (declaration: Revision) => `${declaration.id}@${declaration.revision}`
const introducedBy = (prefix: string) => (problem: string) => `${prefix}${problem}`
export const repeatedKeys = (values: ReadonlyArray<string>) => pipe(Array.groupBy(values, Function.identity), Record.filter(isRepeated), Record.keys)

const literalTag = (field: SchemaAST.PropertySignature) => {
  const isTag = Equal.equals(field.name, "_tag")
  const literalType = SchemaAST.isLiteral(field.type)
  const tag = isTag && literalType ? Option.some(field.type.literal) : Option.none()

  return Option.map(tag, String)
}

const failureTags = (ast: SchemaAST.AST): ReadonlyArray<string> => {
  const type = SchemaAST.toType(ast)

  if (SchemaAST.isUnion(type)) return Array.flatMap(type.types, failureTags)

  if (SchemaAST.isDeclaration(type)) return Array.flatMap(type.typeParameters, failureTags)

  const signatures = SchemaAST.isObjects(type) ? type.propertySignatures : Array.empty<SchemaAST.PropertySignature>()

  return pipe(signatures, Array.map(literalTag), Array.getSomes)
}

const middlewareFailures = (middleware: NativeOperation["middlewares"] extends Iterable<infer Middleware> ? Middleware : never) => failureTags(middleware.error.ast)

const middlewareTags = (operation: NativeOperation) => {
  const middlewares = Array.fromIterable(operation.middlewares)

  return Array.flatMap(middlewares, middlewareFailures)
}

const nativeFailures = (operation: NativeOperation) => {
  const declared = failureTags(operation.errorSchema.ast)
  const middleware = middlewareTags(operation)

  return [...declared, ...middleware]
}

const payloadFields = (operation: NativeOperation) => {
  const type = SchemaAST.toType(operation.payloadSchema.ast)
  const objects = SchemaAST.isObjects(type) ? type.propertySignatures : Array.empty<SchemaAST.PropertySignature>()

  return Array.map(objects, fieldName)
}

const fieldName = (field: SchemaAST.PropertySignature) => String(field.name)
const named = (name: string) => (operation: NativeOperation) => Equal.equals(operation._tag, name)
const nativeOperation = (application: ApplicationIR, name: string) => pipe(application, nativeOperations, Array.findFirst(named(name)))
const isDenied = Schema.is(DeniedSchema)

const resolvedIn = (reference: string, owner: Catalog) => (requirement: Requirement) => ResolvedRequirement.make({ reference, owner: owner.id, requirement })

const qualifiedIn = (reference: string, id: string) => (entry: ImportedCatalog) => {
  const target = Array.findFirst(entry.catalog.requirements, byId(id))
  const missing = `Missing requirement ${id} in imported catalog ${entry.catalog.id}@${entry.catalog.revision} (${entry.alias}); reference a requirement that catalog declares`

  return pipe(target, Option.map(resolvedIn(reference, entry.catalog)), Result.fromOption(Function.constant(missing)))
}

const resolveQualified = (scope: ReferenceScope, reference: string, alias: string, id: string) => {
  const imported = Array.findFirst(scope.imports, byAlias(alias))
  const unknown = Result.fail(`Unknown import alias ${alias} in ${reference}; declare the alias under imports or use a local requirement id`)

  return Option.match(imported, { onNone: Function.constant(unknown), onSome: qualifiedIn(reference, id) })
}

const declaring = (id: string) => (entry: ImportedCatalog) => Array.some(entry.catalog.requirements, byId(id))

const resolveUnqualified = (scope: ReferenceScope, reference: string) => {
  const local = Array.findFirst(scope.catalog.requirements, byId(reference))
  const providers = Array.filter(scope.imports, declaring(reference))
  const aliases = pipe(providers, Array.map(Struct.get("alias")), Array.join(", "))
  const ambiguous = Array.length(providers) > 1
  const missing = Result.fail(`Missing requirement ${reference}`)
  const imported = Array.head(providers)
  const fromImport = Option.match(imported, { onNone: Function.constant(missing), onSome: qualifiedIn(reference, reference) })
  const localResolution = Option.map(local, resolvedIn(reference, scope.catalog))

  if (Option.isSome(localResolution)) return Result.succeed(localResolution.value)

  if (ambiguous) return Result.fail(`Ambiguous requirement reference ${reference}: declared by imports ${aliases}; qualify as alias:${reference}`)

  return fromImport
}

/** Resolves an authored `ID` or `alias:ID` reference because local, imported, and ambiguous references need distinct actionable failures. */
const resolveReference = (scope: ReferenceScope) => (reference: string): Result.Result<ResolvedRequirement, string> => {
  const parts = Text.split(reference, ":")
  const count = Array.length(parts)
  const blank = Array.some(parts, Text.isEmpty)
  const overqualified = count > 2
  const malformed = blank || overqualified
  const alias = Array.headNonEmpty(parts)
  const target = Array.get(parts, 1)

  if (malformed) return Result.fail(`Malformed requirement reference ${reference}; use ID or alias:ID`)

  return Option.match(target, {
    onNone: () => resolveUnqualified(scope, reference),
    onSome: (id) => resolveQualified(scope, reference, alias, id),
  })
}

const resolvedKey = (resolved: ResolvedRequirement) => `${resolved.owner}/${resolved.requirement.id}`

const bindAs = (reference: string) => (requirement: Requirement) => {
  const evaluation = Option.all([requirement.evaluator, requirement.evaluatorRevision])

  const bound = ([evaluator, evaluatorRevision]: readonly [string, string]) =>
    BoundRequirement.make({ reference, id: requirement.id, revision: requirement.revision, text: requirement.text, category: requirement.category, evaluator, evaluatorRevision })

  return Option.map(evaluation, bound)
}

/** Binds a requirement under its own local id because application verifiers judge declared local obligations without a scenario run. */
export const bindLocalRequirement = (requirement: Requirement) => bindAs(requirement.id)(requirement)

const boundResolution = (resolved: ResolvedRequirement) => pipe(resolved.requirement, bindAs(resolved.reference))

const catalogDeclarations = (catalog: Catalog): ReadonlyArray<Revision> => [
  catalog,
  ...catalog.actors,
  ...catalog.contexts,
  ...catalog.needs,
  ...catalog.capabilities,
  ...catalog.features,
  ...catalog.textFixtures,
  ...catalog.rubrics,
  ...catalog.requirements,
  ...catalog.stories,
  ...catalog.scenarios,
]

const duplicateProblems = (catalog: Catalog) => {
  const ids = pipe(catalog, catalogDeclarations, Array.map(Struct.get("id")))
  const aliases = Array.map(catalog.imports, Struct.get("alias"))
  const records = Array.map(catalog.approvals, Struct.get("id"))
  const duplicateAlias = (alias: string) => `Duplicate import alias: ${alias}; each import needs its own alias`
  const duplicateRecord = (id: string) => `Duplicate approval record id: ${id}`
  const repeatedIds = repeatedKeys(ids)
  const repeatedAliases = repeatedKeys(aliases)
  const repeatedRecords = repeatedKeys(records)

  return [
    ...Array.map(repeatedIds, duplicateProblem),
    ...Array.map(repeatedAliases, duplicateAlias),
    ...Array.map(repeatedRecords, duplicateRecord),
  ]
}

const revisionOf = (id: string) => Text.startsWith(`${id}@`)

/** Requirements and rubrics may stay proposed because a proposed qualitative judgment is assessed and reported, never executed as an obligation. */
const proposable = (catalog: Catalog) => {
  const requirements = Array.map(catalog.requirements, Struct.get("id"))
  const rubrics = Array.map(catalog.rubrics, Struct.get("id"))

  return [...requirements, ...rubrics]
}

const historyProblems = (approved: ReadonlyArray<string>, proposals: ReadonlyArray<string>) => (declaration: Revision) => {
  const current = qualifiedName(declaration)
  const unapproved = !Equal.equals(declaration.approval, "approved")
  const proposed = Equal.equals(declaration.approval, "proposed")
  const admissible = proposed && Array.contains(proposals, declaration.id)
  const recorded = Array.contains(approved, current)
  const earlier = Array.filter(approved, revisionOf(declaration.id))
  const obsolete = Array.isReadonlyArrayNonEmpty(earlier)
  const earlierList = Array.join(earlier, ", ")

  if (admissible) return problemIf(recorded, `Declaration ${current} is proposed but an approval record approves ${current}; mark it approved or remove the approval`)

  if (unapproved) return Array.of(`Declaration ${current} is ${declaration.approval}, not an approved obligation`)

  if (recorded) return Array.empty<string>()

  if (obsolete) return Array.of(`Declaration ${current} has only an obsolete approval (${earlierList}); record an approval of ${current} before executing it`)

  return Array.of(`Declaration ${current} is marked approved but no approval record approves ${current}`)
}

const entryProblems = (declared: ReadonlyArray<string>, record: ApprovalRecord) => (entry: string) => {
  const parts = Text.split(entry, "@")
  const pair = pipe(parts, Array.length, Equal.equals(2))
  const filled = Array.every(parts, Text.isNonEmpty)
  const wellFormed = pair && filled
  const id = Array.headNonEmpty(parts)
  const known = Array.contains(declared, id)

  if (!wellFormed) return Array.of(`Approval ${record.id} entry ${entry} is malformed; use id@revision`)

  return problemIf(!known, `Approval ${record.id} approves unknown declaration ${entry}; approve only declarations of this catalog`)
}

const recordProblems = (declared: ReadonlyArray<string>) => (record: ApprovalRecord) => Array.flatMap(record.approves, entryProblems(declared, record))

const approvalProblems = (catalog: Catalog) => {
  const declarations = catalogDeclarations(catalog)
  const declared = Array.map(declarations, Struct.get("id"))
  const approved = Array.flatMap(catalog.approvals, Struct.get("approves"))
  const proposals = proposable(catalog)

  return [...Array.flatMap(declarations, historyProblems(approved, proposals)), ...Array.flatMap(catalog.approvals, recordProblems(declared))]
}

const memberOf = (feature: Feature) => (capability: string) => Tuple.make(capability, feature.id)
const membershipsOf = (feature: Feature) => Array.map(feature.capabilities, memberOf(feature))

const sharedProblem = (entry: readonly [string, Array.NonEmptyReadonlyArray<readonly [string, string]>]) => {
  const [capability, memberships] = entry
  const features = pipe(memberships, Array.map(Tuple.get(1)), Array.join(", "))

  return `Capability ${capability} belongs to more than one feature (${features}); a capability may belong to at most one feature`
}

const unknownMembers = (capabilities: ReadonlyArray<string>) => (feature: Feature) => {
  const unknown = Array.filter(feature.capabilities, Predicate.not(amongst(capabilities)))
  const unknownProblem = (capability: string) => `Feature ${feature.id} names unknown capability ${capability}`

  return Array.map(unknown, unknownProblem)
}

const featureProblems = (catalog: Catalog) => {
  const capabilities = Array.map(catalog.capabilities, Struct.get("id"))
  const memberships = Array.flatMap(catalog.features, membershipsOf)
  const shared = pipe(Array.groupBy(memberships, Tuple.get(0)), Record.filter(isRepeated), Record.toEntries)

  return [...Array.flatMap(catalog.features, unknownMembers(capabilities)), ...Array.map(shared, sharedProblem)]
}

const argumentProblems = (requirement: Requirement, refinement: Refinement) => (target: ResolvedRequirement) => {
  const parameters = Array.map(target.requirement.parameters, Struct.get("name"))
  const bound = Record.keys(refinement.arguments)
  const missing = Array.filter(parameters, Predicate.not(amongst(bound)))
  const extra = Array.filter(bound, Predicate.not(amongst(parameters)))
  const unbound = Array.isReadonlyArrayNonEmpty(missing)
  const unexpected = Array.isReadonlyArrayNonEmpty(extra)
  const where = `Requirement ${requirement.id} refinement of ${refinement.requirement}`
  const declared = Array.isReadonlyArrayNonEmpty(parameters) ? Array.join(parameters, ", ") : "no parameters"
  const missingList = Array.join(missing, ", ")
  const extraList = Array.join(extra, ", ")

  return [
    ...problemIf(unbound, `${where} does not bind parameter(s) ${missingList}; bind every declared parameter`),
    ...problemIf(unexpected, `${where} binds unknown parameter(s) ${extraList}; ${target.requirement.id} declares ${declared}`),
  ]
}

const unresolvedRefinement = (requirement: Requirement) => (problem: string) => Array.of(`Requirement ${requirement.id} refines an unresolved requirement: ${problem}`)

const refinementProblems = (scope: ReferenceScope, requirement: Requirement) => (refinement: Refinement) => {
  const resolved = resolveReference(scope)(refinement.requirement)

  return Result.match(resolved, { onFailure: unresolvedRefinement(requirement), onSuccess: argumentProblems(requirement, refinement) })
}

const localTarget = (catalog: Catalog) => (requirement: Requirement) => {
  const target = Option.map(requirement.refines, Struct.get("requirement"))

  return Option.flatMap(target, findRequirementIn(catalog))
}

const findRequirementIn = (catalog: Catalog) => (id: string) => Array.findFirst(catalog.requirements, byId(id))

/** Follows local refinements because imports are acyclic, so any refinement cycle stays inside one catalog. */
const reachesItself = (catalog: Catalog, start: string, visited: ReadonlyArray<string>) => (requirement: Requirement): boolean => {
  const target = localTarget(catalog)(requirement)

  return Option.exists(target, continuesTo(catalog, start, visited))
}

const continuesTo = (catalog: Catalog, start: string, visited: ReadonlyArray<string>) => (target: Requirement): boolean => {
  const returned = Equal.equals(target.id, start)
  const fresh = !Array.contains(visited, target.id)
  const extended = Array.append(visited, target.id)
  const onward = fresh && reachesItself(catalog, start, extended)(target)

  return returned || onward
}

const rubricNamed = (catalog: Catalog) => (id: string) => Array.some(catalog.rubrics, byId(id))

const assessedBy = (requirement: Requirement) => {
  const evaluator = Option.contains(requirement.evaluator, rubricAssessment)
  const revision = Option.contains(requirement.evaluatorRevision, rubricAssessmentRevision)

  return evaluator && revision
}

/** A qualitative requirement needs a rubric of its own catalog and the package rubric assessment, and only it may name a rubric, because a rating without declared criteria is no evidence. */
const qualitativeProblems = (catalog: Catalog, requirement: Requirement) => {
  const qualitative = isQualitative(requirement)
  const named = Option.isSome(requirement.rubric)
  const declared = Option.exists(requirement.rubric, rubricNamed(catalog))
  const assessed = assessedBy(requirement)
  const rubricName = Option.getOrElse(requirement.rubric, Function.constant("(none)"))

  if (!qualitative) return problemIf(named, `Requirement ${requirement.id} names rubric ${rubricName} but only a qualitative requirement is reviewed against a rubric`)

  return [
    ...problemIf(!declared, `Qualitative requirement ${requirement.id} names missing rubric ${rubricName}; declare it under rubrics`),
    ...problemIf(!assessed, `Qualitative requirement ${requirement.id} must bind evaluator ${rubricAssessment}@${rubricAssessmentRevision}, the package model assessment`),
  ]
}

const requirementProblems = (scope: ReferenceScope) => (requirement: Requirement) => {
  const hasEvaluator = Option.isSome(requirement.evaluator)
  const hasRevision = Option.isSome(requirement.evaluatorRevision)
  const unpaired = !Equal.equals(hasEvaluator, hasRevision)
  const names = Array.map(requirement.parameters, Struct.get("name"))
  const repeated = repeatedKeys(names)
  const refinement = Option.match(requirement.refines, { onNone: Array.empty<string>, onSome: refinementProblems(scope, requirement) })
  const cyclic = reachesItself(scope.catalog, requirement.id, [requirement.id])(requirement)
  const repeatedProblem = (name: string) => `Requirement ${requirement.id} declares parameter ${name} more than once`

  return [
    ...problemIf(unpaired, `Requirement ${requirement.id} must declare evaluator and evaluatorRevision together`),
    ...Array.map(repeated, repeatedProblem),
    ...refinement,
    ...problemIf(cyclic, `Requirement ${requirement.id} is part of a refinement cycle; a refinement chain must end at a requirement that refines nothing`),
    ...qualitativeProblems(scope.catalog, requirement),
  ]
}

const levelOf = Struct.get<Rubric["scale"][number], "level">("level")

/** A rubric needs criteria, an ordered scale of at least two distinct levels, and a threshold on that scale because otherwise no rating can be interpreted. */
const rubricProblems = (rubric: Rubric) => {
  const levels = Array.map(rubric.scale, levelOf)
  const repeated = repeatedKeys(levels)
  const graded = Array.length(levels) > 1
  const anchored = Array.contains(levels, rubric.threshold)
  const criteria = Array.isReadonlyArrayNonEmpty(rubric.criteria)
  const where = `Rubric ${rubric.id}`
  const repeatedList = Array.join(repeated, ", ")
  const duplicated = Array.isReadonlyArrayNonEmpty(repeated)

  return [
    ...problemIf(!criteria, `${where} declares no criteria`),
    ...problemIf(!graded, `${where} needs an ordered scale of at least two levels`),
    ...problemIf(duplicated, `${where} repeats scale level(s) ${repeatedList}`),
    ...problemIf(!anchored, `${where} threshold ${rubric.threshold} is not a level of its scale`),
  ]
}

const evaluatorName = (requirement: Requirement) => Option.getOrElse(requirement.evaluator, Function.constant("(none)"))

const evaluatorBinding = (requirement: Requirement) => {
  const revision = Option.getOrElse(requirement.evaluatorRevision, Function.constant("(none)"))

  return `${evaluatorName(requirement)}@${revision}`
}

/** An obligation must be an approved, non-qualitative requirement with an executable evaluator because proposed, qualitative, and model-assessed judgments are only ever assessed, never executed. */
const obligationProblems = (owner: string) => (resolved: ResolvedRequirement) => {
  const { requirement } = resolved
  const unapproved = !Equal.equals(requirement.approval, "approved")
  const qualitative = isQualitative(requirement)
  const modelAssessed = Option.contains(requirement.evaluator, rubricAssessment)
  const binding = evaluatorBinding(requirement)

  return [
    ...problemIf(unapproved, `${owner} references ${resolved.reference}@${requirement.revision}, which is ${requirement.approval}; only approved requirements are obligations (reference a proposed qualitative requirement under a scenario's assessments)`),
    ...problemIf(qualitative, `${owner} references qualitative requirement ${resolved.reference} as an obligation; reference it under a scenario's assessments`),
    ...problemIf(modelAssessed, `${owner} references ${resolved.reference} as an obligation, but its evaluator ${binding} is the model assessment, which never executes an obligation; bind an executable evaluator or reference it under a scenario's assessments`),
  ]
}

const storyProblems = (scope: ReferenceScope) => (story: Catalog["stories"][number]) => {
  const { catalog } = scope
  const hasActor = Array.some(catalog.actors, byId(story.actor))
  const hasNeed = Array.some(catalog.needs, byId(story.need))
  const hasContext = Array.some(catalog.contexts, byId(story.context))
  const capabilityIds = Array.map(catalog.capabilities, Struct.get("id"))
  const missingCapabilities = Array.filter(story.capabilities, Predicate.not(amongst(capabilityIds)))
  const resolved = Array.every([hasActor, hasNeed], Boolean)
  const resolutions = Array.map(story.requirements, resolveReference(scope))
  const unresolvedRequirements = Array.getFailures(resolutions)
  const obligations = pipe(resolutions, Array.getSuccesses, Array.flatMap(obligationProblems(`Story ${story.id}`)))
  const undecided = Array.isReadonlyArrayNonEmpty(story.openDecisions)
  const decisions = Array.join(story.openDecisions, ", ")
  const missingCapability = (id: string) => `Missing capability ${id} in ${story.id}`

  return [
    ...problemIf(!resolved, `Unresolved actor or need in story ${story.id}`),
    ...problemIf(!hasContext, `Missing context ${story.context} in story ${story.id}; declare it under contexts`),
    ...problemIf(undecided, `Unresolved decisions in ${story.id}: ${decisions}`),
    ...Array.map(unresolvedRequirements, introducedBy(`Story ${story.id}: `)),
    ...Array.map(missingCapabilities, missingCapability),
    ...obligations,
  ]
}

const contextFixtures = (catalog: Catalog) => (story: Catalog["stories"][number]) => {
  const context = Array.findFirst(catalog.contexts, byId(story.context))

  return Option.match(context, { onNone: Array.empty<string>, onSome: Struct.get("fixtures") })
}

const scopedKeys = (scope: ReferenceScope) => (story: Catalog["stories"][number]) => pipe(story.requirements, Array.map(resolveReference(scope)), Array.getSuccesses, Array.map(resolvedKey))

const scenarioRequirementProblems = (scenario: Scenario, scoped: ReadonlyArray<string>) => (resolved: ResolvedRequirement) => {
  const key = resolvedKey(resolved)
  const binding = boundResolution(resolved)
  const inScope = Array.contains(scoped, key)
  const unbound = Option.isNone(binding)

  return [
    ...problemIf(!inScope, `Requirement ${resolved.reference} is not scoped to story ${scenario.story}`),
    ...problemIf(unbound, `Requirement ${resolved.reference} is referenced by scenario ${scenario.id} but declares no evaluator binding`),
    ...obligationProblems(`Scenario ${scenario.id}`)(resolved),
  ]
}

const assessmentProblems = (scenario: Scenario) => (resolved: ResolvedRequirement) => {
  const { requirement } = resolved
  const qualitative = isQualitative(requirement)
  const assessed = assessedBy(requirement)
  const binding = evaluatorBinding(requirement)

  return [
    ...problemIf(!qualitative, `Scenario ${scenario.id} assesses ${resolved.reference}, which is not a qualitative requirement; reference executable obligations under requirements`),
    ...problemIf(!assessed, `Scenario ${scenario.id} assesses ${resolved.reference}, whose evaluator ${binding} is not the model assessment ${rubricAssessment}@${rubricAssessmentRevision}; only a model-assessed requirement can be assessed`),
  ]
}

const laneInputs = (concurrency: Concurrency) => Array.flatMap(concurrency.lanes, Struct.get("inputs"))

/** Lanes must partition the required inputs among at least two distinct contexts because each competing submission belongs to exactly one isolated context. */
const concurrencyProblems = (scenario: Scenario) => (concurrency: Concurrency) => {
  const lanes = Array.map(concurrency.lanes, Struct.get("id"))
  const inputs = laneInputs(concurrency)
  const repeatedLanes = repeatedKeys(lanes)
  const repeatedInputs = repeatedKeys(inputs)
  const unclaimed = Array.filter(scenario.required, Predicate.not(amongst(inputs)))
  const unrequired = Array.filter(inputs, Predicate.not(amongst(scenario.required)))
  const competing = Array.length(lanes) > 1
  const emptyLane = Array.some(concurrency.lanes, flow(Struct.get("inputs"), Array.isReadonlyArrayEmpty))
  const where = `Scenario ${scenario.id}`

  return [
    ...problemIf(!competing, `${where} declares concurrency with fewer than two lanes`),
    ...listProblem(repeatedLanes, repeatedLaneText(where)),
    ...listProblem(repeatedInputs, sharedInputText(where)),
    ...listProblem(unclaimed, unclaimedText(where)),
    ...listProblem(unrequired, unrequiredText(where)),
    ...problemIf(emptyLane, `${where} declares a lane without inputs`),
  ]
}

const repeatedLaneText = (where: string) => (list: string) => `${where} repeats lane id(s) ${list}`

const sharedInputText = (where: string) => (list: string) => `${where} assigns input(s) ${list} to more than one lane`

const unclaimedText = (where: string) => (list: string) => `${where} leaves required input(s) ${list} outside every lane`

const unrequiredText = (where: string) => (list: string) => `${where} assigns lane input(s) ${list} that are not required`

const contendedText = (scenario: Scenario) => (list: string) => `Scenario ${scenario.id} declares contended input(s) ${list} without concurrency lanes`

const listProblem = (items: ReadonlyArray<string>, describe: (list: string) => string) => {
  const present = Array.isReadonlyArrayNonEmpty(items)
  const list = Array.join(items, ", ")
  const message = describe(list)

  return problemIf(present, message)
}

const watchProblems = (scenario: Scenario) => (watch: Watch) => {
  const where = `Scenario ${scenario.id} watch`
  const required = Array.contains(scenario.required, watch.input)
  const terminal = Array.isReadonlyArrayNonEmpty(watch.terminal)
  const interval = watch.intervalMillis > 0
  const deadline = watch.deadlineSeconds > 0
  const confirmations = watch.confirmations >= 0

  return [
    ...problemIf(!required, `${where} input ${watch.input} is not a required input`),
    ...problemIf(!terminal, `${where} declares no terminal state`),
    ...problemIf(!interval, `${where} needs a positive poll interval`),
    ...problemIf(!deadline, `${where} needs a positive deadline`),
    ...problemIf(!confirmations, `${where} needs zero or more confirmations`),
  ]
}

const isContended = Schema.is(ContendedSchema)

const contendedProblems = (scenario: Scenario) => {
  const contended = pipe(scenario.inputs, Array.filter(flow(Struct.get("outcome"), isContended)), Array.map(Struct.get("id")))
  const concurrent = Option.isSome(scenario.concurrency)

  return concurrent ? Array.empty<string>() : listProblem(contended, contendedText(scenario))
}

const scenarioDeclarationProblems = (scope: ReferenceScope) => (scenario: Scenario) => {
  const { catalog } = scope
  const story = Array.findFirst(catalog.stories, byId(scenario.story))
  const storyActor = Option.map(story, Struct.get("actor"))
  const actorMatches = Option.contains(storyActor, scenario.actor)
  const actorDeclared = Array.some(catalog.actors, byId(scenario.actor))
  const storyMissing = Option.isNone(story)
  const admitted = Option.match(story, { onNone: Array.empty<string>, onSome: contextFixtures(catalog) })
  const storyContext = pipe(story, Option.map(Struct.get("context")), Option.getOrElse(Function.constant("(none)")))
  const fixtureAdmitted = Array.contains(admitted, scenario.fixture)
  const scoped = Option.match(story, { onNone: Array.empty<string>, onSome: scopedKeys(scope) })
  const resolutions = Array.map(scenario.requirements, resolveReference(scope))
  const unresolved = Array.getFailures(resolutions)
  const resolved = Array.getSuccesses(resolutions)
  const inputIds = Array.map(scenario.inputs, Struct.get("id"))
  const missingRequired = Array.filter(scenario.required, Predicate.not(amongst(inputIds)))
  const missingRequiredProblem = (id: string) => `Required input ${id} is not declared in ${scenario.id}`
  const assessments = Array.map(scenario.assessments, resolveReference(scope))
  const unresolvedAssessments = Array.getFailures(assessments)
  const assessed = Array.getSuccesses(assessments)
  const concurrency = Option.match(scenario.concurrency, { onNone: Array.empty<string>, onSome: concurrencyProblems(scenario) })
  const watch = Option.match(scenario.watch, { onNone: Array.empty<string>, onSome: watchProblems(scenario) })

  return [
    ...problemIf(storyMissing, `Missing story ${scenario.story} in ${scenario.id}`),
    ...problemIf(!actorMatches, `Scenario ${scenario.id} actor does not match its story`),
    ...problemIf(!actorDeclared, `Missing actor ${scenario.actor} in ${scenario.id}`),
    ...problemIf(!fixtureAdmitted, `Scenario ${scenario.id} fixture ${scenario.fixture} is not a precondition of context ${storyContext}; add it to that context's fixtures or choose an admitted fixture`),
    ...Array.map(unresolved, introducedBy(`Scenario ${scenario.id}: `)),
    ...Array.flatMap(resolved, scenarioRequirementProblems(scenario, scoped)),
    ...Array.map(missingRequired, missingRequiredProblem),
    ...Array.map(unresolvedAssessments, introducedBy(`Scenario ${scenario.id} assessment: `)),
    ...Array.flatMap(assessed, assessmentProblems(scenario)),
    ...concurrency,
    ...watch,
    ...contendedProblems(scenario),
  ]
}

const decodeImported = Schema.decodeUnknownResult(Catalog)
const failedImport = (problem: string) => ImportCheck.make({ imported: Option.none(), problems: [problem] })
const importLabel = (entry: CatalogImport) => `import ${entry.alias} (${entry.catalog}@${entry.revision})`

const invalidImport = (entry: CatalogImport) => (error: Schema.SchemaError) => {
  const label = importLabel(entry)

  return failedImport(`Invalid ${label}: ${error.message}`)
}

const pinnedAs = (pinned: string) => (declaration: Revision) => {
  const name = qualifiedName(declaration)

  return Equal.equals(name, pinned)
}

const importedFrom = (registry: ReadonlyArray<Declaration>, trail: ReadonlyArray<string>, entry: CatalogImport) => (catalog: Catalog) => {
  const nested = Array.append(trail, catalog.id)
  const checked = checkDeclaration(registry, nested)(catalog)
  const prefix = `Imported catalog ${entry.alias} (${qualifiedName(catalog)}): `
  const problems = Array.map(checked.problems, introducedBy(prefix))
  const imported = ImportedCatalog.make({ alias: entry.alias, catalog })

  return ImportCheck.make({ imported: Option.some(imported), problems })
}

const decodedImport = (registry: ReadonlyArray<Declaration>, trail: ReadonlyArray<string>, entry: CatalogImport) => (declaration: Declaration) => {
  const decoded = decodeImported(declaration)

  return Result.match(decoded, { onFailure: invalidImport(entry), onSuccess: importedFrom(registry, trail, entry) })
}

const checkImport = (registry: ReadonlyArray<Declaration>, trail: ReadonlyArray<string>) => (entry: CatalogImport) => {
  const label = importLabel(entry)
  const available = Array.filter(registry, byId(entry.catalog))
  const pinned = `${entry.catalog}@${entry.revision}`
  const exact = Array.findFirst(available, pinnedAs(pinned))
  const revisions = pipe(available, Array.map(Struct.get("revision")), Array.join(", "))
  const cyclic = Array.contains(trail, entry.catalog)
  const cycle = pipe(trail, Array.append(entry.catalog), Array.join(" -> "))
  const missing = Array.isReadonlyArrayEmpty(available)
  const obsolete = failedImport(`Obsolete ${label}: available revision(s) ${revisions}; review the changed obligations and update the import revision`)

  if (cyclic) return failedImport(`Import cycle ${cycle}; a catalog cannot import itself directly or transitively`)

  if (missing) return failedImport(`Missing ${label}: no available catalog ${entry.catalog}; supply it in the catalog registry or remove the import`)

  return Option.match(exact, { onNone: Function.constant(obsolete), onSome: decodedImport(registry, trail, entry) })
}

/** Checks everything a catalog declares independently of any application because imported catalogs must satisfy the same approval and reference rules. */
const checkDeclaration = (registry: ReadonlyArray<Declaration>, trail: ReadonlyArray<string>) => (catalog: Catalog): CheckedDeclaration => {
  const checks = Array.map(catalog.imports, checkImport(registry, trail))
  const imports = pipe(checks, Array.map(Struct.get("imported")), Array.getSomes)
  const scope = ReferenceScope.make({ catalog, imports })

  const problems = [
    ...duplicateProblems(catalog),
    ...Array.flatMap(checks, Struct.get("problems")),
    ...approvalProblems(catalog),
    ...featureProblems(catalog),
    ...Array.flatMap(catalog.requirements, requirementProblems(scope)),
    ...Array.flatMap(catalog.rubrics, rubricProblems),
    ...Array.flatMap(catalog.stories, storyProblems(scope)),
    ...Array.flatMap(catalog.scenarios, scenarioDeclarationProblems(scope)),
  ]

  return CheckedDeclaration.make({ scope, problems })
}

const capabilityProblems = (application: ApplicationIR) => (capability: Catalog["capabilities"][number]) => {
  const missingOperations = Array.filter(capability.operations, Predicate.not(operationIn(application)))
  const resourceMissing = !resourceIn(application)(capability.resource)

  return [...problemIf(resourceMissing, `Missing resource ${capability.resource}`), ...Array.map(missingOperations, operationProblem)]
}

/** The rubric assessment is always available because the package owns it; every other evaluator must be bound by the application. */
const availability = (bindings: CatalogBindings) => ([evaluator, revision]: readonly [string, string]) => {
  const bound = Record.get(bindings.evaluators, evaluator)
  const available = Option.contains(bound, revision)
  const packaged = Equal.equals(`${evaluator}@${revision}`, `${rubricAssessment}@${rubricAssessmentRevision}`)
  const usable = available || packaged

  return problemIf(!usable, `Unavailable evaluator ${evaluator}@${revision}`)
}

const evaluatorProblems = (bindings: CatalogBindings) => (entry: Requirement) => {
  const evaluation = Option.all([entry.evaluator, entry.evaluatorRevision])

  return Option.match(evaluation, { onNone: Array.empty<string>, onSome: availability(bindings) })
}

const actorProblems = (bindings: CatalogBindings) => (entry: Catalog["actors"][number]) => {
  const bound = Array.contains(bindings.actors, entry.binding)

  return problemIf(!bound, `Missing actor binding ${entry.binding}`)
}

const contextProblems = (bindings: CatalogBindings) => (context: ProductContext) => {
  const unbound = Array.filter(context.fixtures, Predicate.not(amongst(bindings.fixtures)))
  const unboundProblem = (fixture: string) => `Missing fixture binding ${fixture} in context ${context.id}`

  return Array.map(unbound, unboundProblem)
}

/** One authored field source of one input case because every source problem must name the scenario, input case, and field it concerns. */
class SourceCase extends Schema.Class<SourceCase>("SourceCase")({
  scenario: Schema.String,
  input: InputCase,
  field: Schema.String,
}) {}

const sourceWhere = (where: SourceCase) => `Scenario ${where.scenario} input ${where.input.id} field ${where.field}`

const nativeProblems = (where: SourceCase, source: typeof NativeSourceSchema.Type) => (operation: NativeOperation) => {
  const { field } = where
  const location = sourceWhere(where)
  const unsupported = (reason: string) => `${location} requests native ${source.strategy}, which the interpreter cannot apply to ${operation._tag}.${field}: ${reason}`

  return pipe(source.strategy, nativeStrategyProblem(operation, field), Option.map(unsupported), Option.toArray)
}

const literalProblems = (where: SourceCase, source: typeof LiteralSourceSchema.Type) => (operation: NativeOperation) => {
  const { input, field } = where
  const location = sourceWhere(where)
  const undecodable = (reason: string) => `${location} declares a literal the native ${operation._tag}.${field} schema does not decode although the input is native-valid: ${reason}`
  const valid = Equal.equals(input.validity, "native-valid")
  const problems = pipe(source.value, literalProblem(operation, field), Option.map(undecodable), Option.toArray)

  return valid ? problems : Array.empty<string>()
}

const fixtureFactProblems = (bindings: CatalogBindings, where: string) => (source: FixtureSource) => {
  const known = Array.contains(bindings.facts, source.fact)

  return problemIf(!known, `Unknown fixture fact ${source.fact} at ${where}`)
}

const textFieldProblems = (catalog: Catalog, where: string) => (source: TextSource) => {
  const fixture = Array.findFirst(catalog.textFixtures, byId(source.fixture))
  const values = Option.map(fixture, Struct.get("values"))
  const hasField = Option.exists(values, Record.has(source.field))

  return problemIf(!hasField, `Missing text fixture field ${source.fixture}.${source.field} at ${where}`)
}

const onNative = (native: Option.Option<NativeOperation>) => (check: (operation: NativeOperation) => ReadonlyArray<string>) => Option.match(native, { onNone: Array.empty<string>, onSome: check })

const nativeSourceProblems = (where: SourceCase, native: Option.Option<NativeOperation>) => (source: typeof NativeSourceSchema.Type) => pipe(nativeProblems(where, source), onNative(native))

const literalSourceProblems = (where: SourceCase, native: Option.Option<NativeOperation>) => (source: typeof LiteralSourceSchema.Type) => pipe(literalProblems(where, source), onNative(native))

// Native strategies and literals are checked against the native field because an inapplicable interpretation must fail validation, not the run.
const sourceProblems = (catalog: Catalog, bindings: CatalogBindings, scenario: Scenario, input: InputCase, native: Option.Option<NativeOperation>) => (entry: readonly [string, FieldSource]) => {
  const [field, source] = entry
  const where = `${input.id}/${field}`
  const located = SourceCase.make({ scenario: scenario.id, input, field })

  return pipe(
    Match.value(source),
    Match.discriminatorsExhaustive("source")({
      fixture: fixtureFactProblems(bindings, where),
      text: textFieldProblems(catalog, where),
      native: nativeSourceProblems(located, native),
      literal: literalSourceProblems(located, native),
      captured: Array.empty<string>,
    }),
  )
}

const inputProblems = (catalog: Catalog, bindings: CatalogBindings, application: ApplicationIR, scenario: Scenario) => (input: InputCase) => {
  const native = nativeOperation(application, input.operation)
  const allowed = Array.contains(scenario.operations, input.operation)
  const fields = Option.match(native, { onNone: Array.empty<string>, onSome: payloadFields })
  const declaredFields = Record.keys(input.fields)
  const unknownFields = Array.filter(declaredFields, Predicate.not(amongst(fields)))
  const failures = Option.match(native, { onNone: Array.empty<string>, onSome: nativeFailures })
  const deniedTags = isDenied(input.outcome) ? Array.of(input.outcome.failure) : Array.empty<string>()
  const contendedTags = isContended(input.outcome) ? input.outcome.failures : Array.empty<string>()
  const expectedTags = [...deniedTags, ...contendedTags]
  const undeclaredFailure = Array.some(expectedTags, Predicate.not(amongst(failures)))
  const invalid = Equal.equals(input.validity, "native-invalid")
  const rejection = Equal.equals(input.outcome.kind, "rejected")
  const missingNative = Option.isNone(native)
  const incoherent = !Equal.equals(invalid, rejection)
  const sources = Record.toEntries(input.fields)
  const unknownField = (name: string) => `Field ${name} is not in the native ${input.operation} payload (${input.id})`

  return [
    ...problemIf(missingNative, `Missing native operation ${input.operation} in ${scenario.id}`),
    ...problemIf(!allowed, `Input ${input.id} uses ${input.operation} outside the scenario's bounded operations`),
    ...Array.map(unknownFields, unknownField),
    ...problemIf(undeclaredFailure, `Input ${input.id} expects a failure the native ${input.operation} contract does not declare`),
    ...problemIf(incoherent, `Input ${input.id} must pair native-invalid input with a rejected outcome and native-valid input with acceptance or a declared denial`),
    ...Array.flatMap(sources, sourceProblems(catalog, bindings, scenario, input, native)),
  ]
}

const watchBindingProblems = (scenario: Scenario, bindings: CatalogBindings) => (watch: Watch) => {
  const probed = Array.contains(bindings.probes, watch.probe)
  const known = Array.contains(bindings.facts, watch.subject)

  return [
    ...problemIf(!probed, `Scenario ${scenario.id} watches probe ${watch.probe}, which the fixture runtime does not implement`),
    ...problemIf(!known, `Scenario ${scenario.id} watches subject fact ${watch.subject}, which the fixture runtime does not declare`),
  ]
}

const scenarioBindingProblems = (catalog: Catalog, bindings: CatalogBindings, application: ApplicationIR) => (scenario: Scenario) => {
  const story = Array.findFirst(catalog.stories, byId(scenario.story))
  const storyCapabilities = Option.match(story, { onNone: Array.empty<string>, onSome: Struct.get("capabilities") })
  const isStoryCapability = (entry: Revision) => Array.contains(storyCapabilities, entry.id)
  const capabilities = Array.filter(catalog.capabilities, isStoryCapability)
  const capabilityOperations = Array.flatMap(capabilities, Struct.get("operations"))
  const uncovered = Array.filter(scenario.operations, Predicate.not(amongst(capabilityOperations)))
  const listable = (resource: string) => operationIn(application)(`${resource}.list`)
  const unobservable = Array.filter(scenario.observations, Predicate.not(listable))
  const fixtureBound = Array.contains(bindings.fixtures, scenario.fixture)
  const uncoveredProblem = (name: string) => `Operation ${name} in ${scenario.id} is not bound through the story's capabilities`
  const unobservableProblem = (resource: string) => `Observation ${resource} in ${scenario.id} has no native list operation`
  const unboundProbes = Array.filter(scenario.probes, Predicate.not(amongst(bindings.probes)))
  const unboundProbeProblem = (probe: string) => `Probe ${probe} in ${scenario.id} is not implemented by the fixture runtime`
  const watch = Option.match(scenario.watch, { onNone: Array.empty<string>, onSome: watchBindingProblems(scenario, bindings) })

  return [
    ...problemIf(!fixtureBound, `Missing fixture binding ${scenario.fixture}`),
    ...Array.map(uncovered, uncoveredProblem),
    ...Array.map(unobservable, unobservableProblem),
    ...Array.map(unboundProbes, unboundProbeProblem),
    ...Array.flatMap(scenario.inputs, inputProblems(catalog, bindings, application, scenario)),
    ...watch,
  ]
}

const scenarioResolutions = (scope: ReferenceScope) => pipe(scope.catalog.scenarios, Array.flatMap(Struct.get("requirements")), Array.dedupe, Array.map(resolveReference(scope)), Array.getSuccesses)

const ownerCatalog = (scope: ReferenceScope, owner: string) => {
  const own = Equal.equals(scope.catalog.id, owner)
  const imported = pipe(scope.imports, Array.map(Struct.get("catalog")), Array.findFirst(byId(owner)))

  return own ? Option.some(scope.catalog) : imported
}

const rubricIn = (id: string) => (catalog: Catalog) => Array.findFirst(catalog.rubrics, byId(id))

const rubricOf = (owner: Option.Option<Catalog>) => (id: string) => Option.flatMap(owner, rubricIn(id))

const boundAssessment = (scope: ReferenceScope) => (resolved: ResolvedRequirement) => {
  const owner = ownerCatalog(scope, resolved.owner)
  const rubric = pipe(resolved.requirement.rubric, Option.flatMap(rubricOf(owner)))
  const bind = (found: Rubric) => BoundAssessment.make({ reference: resolved.reference, requirement: resolved.requirement, rubric: found })

  return Option.map(rubric, bind)
}

const assessmentResolutions = (scope: ReferenceScope) => pipe(
  scope.catalog.scenarios,
  Array.flatMap(Struct.get("assessments")),
  Array.dedupe,
  Array.map(resolveReference(scope)),
  Array.getSuccesses,
  Array.map(boundAssessment(scope)),
  Array.getSomes,
)

const foreignTo = (catalog: Catalog) => (resolved: ResolvedRequirement): boolean => !Equal.equals(resolved.owner, catalog.id)

/** Checks the root catalog against the compiled application and runtime bindings because only its scenarios are executed. */
const bindingProblems = (scope: ReferenceScope, bindings: CatalogBindings, application: ApplicationIR) => {
  const { catalog } = scope
  const importedRequirements = pipe(scope, scenarioResolutions, Array.filter(foreignTo(catalog)), Array.map(Struct.get("requirement")))
  const evaluated = [...catalog.requirements, ...importedRequirements]

  return [
    ...Array.flatMap(catalog.capabilities, capabilityProblems(application)),
    ...Array.flatMap(evaluated, evaluatorProblems(bindings)),
    ...Array.flatMap(catalog.actors, actorProblems(bindings)),
    ...Array.flatMap(catalog.contexts, contextProblems(bindings)),
    ...Array.flatMap(catalog.scenarios, scenarioBindingProblems(catalog, bindings, application)),
  ]
}

const decodeCatalog = Schema.decodeUnknownEffect(Catalog)
const invalidDeclaration = (error: Schema.SchemaError) => AcceptanceError.make({ boundary: "catalog", message: error.message })

/** Decodes, resolves imports and references, and checks bindings because only a contract-ready catalog may be executed. */
export const validateCatalog = Effect.fn("Acceptance.validateCatalog")(function* (input: unknown, bindings: CatalogBindings, application: ApplicationIR) {
  const catalog = yield* pipe(input, decodeCatalog, Effect.mapError(invalidDeclaration))
  const checked = checkDeclaration(bindings.catalogs, [catalog.id])(catalog)
  const bound = bindingProblems(checked.scope, bindings, application)
  const problems = [...checked.problems, ...bound]
  const message = Array.join(problems, "; ")
  const requirements = pipe(checked.scope, scenarioResolutions, Array.map(boundResolution), Array.getSomes)
  const assessments = assessmentResolutions(checked.scope)

  if (Array.isReadonlyArrayNonEmpty(problems)) return yield* AcceptanceError.make({ boundary: "catalog", message })

  return ValidatedCatalog.make({ catalog, requirements, assessments })
})
