import { Array, Effect, Equal, Function, Match, Option, Predicate, Record, Schema, SchemaAST, Struct, pipe } from "effect"
import type { ApplicationIR } from "effect-domains/application"
import { AcceptanceError, Catalog, DeniedSchema, type FieldSource, type FixtureSource, type InputCase, type LiteralSourceSchema, type NativeSourceSchema, type Scenario } from "./model.ts"
import { literalProblem, nativeStrategyProblem } from "./inputs.ts"

const NamesSchema = Schema.Array(Schema.String)

/** What the application and its fixture runtime provide because every catalog reference must resolve against them. */
export class CatalogBindings extends Schema.Class<CatalogBindings>("CatalogBindings")({
  evaluators: NamesSchema,
  fixtures: NamesSchema,
  actors: NamesSchema,
  facts: NamesSchema,
  probes: NamesSchema,
}) {}

export type NativeOperation = NonNullable<ReturnType<ApplicationIR["group"]["requests"]["get"]>>

export const nativeOperations = (application: ApplicationIR): ReadonlyArray<NativeOperation> => pipe(application.group.requests.values(), Array.fromIterable)

type Identified = Readonly<{ id: string }>

const operationNames = (application: ApplicationIR) => pipe(application, nativeOperations, Array.map(Struct.get("_tag")))
const operationIn = (application: ApplicationIR) => (name: string): boolean => pipe(application, operationNames, Array.contains(name))
export const byId = (id: string) => (declaration: Identified) => Equal.equals(declaration.id, id)
const amongst = (values: ReadonlyArray<string>) => (value: string): boolean => Array.contains(values, value)
const isRepeated = (group: Array.NonEmptyReadonlyArray<unknown>) => Array.length(group) > 1
const problemIf = (condition: boolean, message: string) => condition ? Array.of(message) : Array.empty<string>()
const repeatedKeys = (values: ReadonlyArray<string>) => pipe(Array.groupBy(values, Function.identity), Record.filter(isRepeated), Record.keys)
const missingAmong = (declared: ReadonlyArray<string>) => (values: ReadonlyArray<string>) => Array.filter(values, Predicate.not(amongst(declared)))

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

const nativeFailures = (operation: NativeOperation) => {
  const declared = failureTags(operation.errorSchema.ast)
  const middlewares = Array.fromIterable(operation.middlewares)
  const middleware = Array.flatMap(middlewares, middlewareFailures)

  return [...declared, ...middleware]
}

const fieldName = (field: SchemaAST.PropertySignature) => String(field.name)

const payloadFields = (operation: NativeOperation) => {
  const type = SchemaAST.toType(operation.payloadSchema.ast)
  const objects = SchemaAST.isObjects(type) ? type.propertySignatures : Array.empty<SchemaAST.PropertySignature>()

  return Array.map(objects, fieldName)
}

const named = (name: string) => (operation: NativeOperation) => Equal.equals(operation._tag, name)
const nativeOperation = (application: ApplicationIR, name: string) => pipe(application, nativeOperations, Array.findFirst(named(name)))
const isDenied = Schema.is(DeniedSchema)

const duplicateProblems = (catalog: Catalog) => {
  const declarations: ReadonlyArray<Identified> = [...catalog.actors, ...catalog.requirements, ...catalog.stories, ...catalog.scenarios]
  const ids = Array.map(declarations, Struct.get("id"))
  const duplicate = (id: string) => `Duplicate declaration id: ${id}`

  return pipe(ids, repeatedKeys, Array.map(duplicate))
}

const requirementProblems = (bindings: CatalogBindings) => (requirement: Catalog["requirements"][number]) => {
  const available = Array.contains(bindings.evaluators, requirement.evaluator)

  return problemIf(!available, `Requirement ${requirement.id} names unavailable evaluator ${requirement.evaluator}`)
}

const actorProblems = (bindings: CatalogBindings) => (actor: Catalog["actors"][number]) => {
  const bound = Array.contains(bindings.actors, actor.binding)

  return problemIf(!bound, `Actor ${actor.id} names missing actor binding ${actor.binding}`)
}

const storyProblems = (catalog: Catalog) => (story: Catalog["stories"][number]) => {
  const hasActor = Array.some(catalog.actors, byId(story.actor))
  const requirementIds = Array.map(catalog.requirements, Struct.get("id"))
  const missing = missingAmong(requirementIds)(story.requirements)
  const missingProblem = (id: string) => `Story ${story.id} references missing requirement ${id}`

  return [
    ...problemIf(!hasActor, `Story ${story.id} references missing actor ${story.actor}`),
    ...Array.map(missing, missingProblem),
  ]
}

/** One authored field source of one input case because every source problem must name the scenario, input case, and field it concerns. */
class SourceCase extends Schema.Class<SourceCase>("SourceCase")({
  scenario: Schema.String,
  input: Schema.String,
  field: Schema.String,
  valid: Schema.Boolean,
}) {}

const sourceWhere = (where: SourceCase) => `Scenario ${where.scenario} input ${where.input} field ${where.field}`

const nativeProblems = (where: SourceCase, source: typeof NativeSourceSchema.Type) => (operation: NativeOperation) => {
  const location = sourceWhere(where)
  const unsupported = (reason: string) => `${location} requests native ${source.strategy}, which the interpreter cannot apply to ${operation._tag}.${where.field}: ${reason}`

  return pipe(source.strategy, nativeStrategyProblem(operation, where.field), Option.map(unsupported), Option.toArray)
}

const literalProblems = (where: SourceCase, source: typeof LiteralSourceSchema.Type) => (operation: NativeOperation) => {
  const location = sourceWhere(where)
  const undecodable = (reason: string) => `${location} declares a literal the native ${operation._tag}.${where.field} schema does not decode although the input is native-valid: ${reason}`
  const problems = pipe(source.value, literalProblem(operation, where.field), Option.map(undecodable), Option.toArray)

  return where.valid ? problems : Array.empty<string>()
}

const onNative = (native: Option.Option<NativeOperation>) => (check: (operation: NativeOperation) => ReadonlyArray<string>) => Option.match(native, { onNone: Array.empty<string>, onSome: check })

const factProblems = (bindings: CatalogBindings, location: string) => (source: FixtureSource) => {
  const known = Array.contains(bindings.facts, source.fact)

  return problemIf(!known, `${location} uses unknown fixture fact ${source.fact}`)
}

const nativeSourceProblems = (where: SourceCase, native: Option.Option<NativeOperation>) => (source: typeof NativeSourceSchema.Type) => pipe(nativeProblems(where, source), onNative(native))

const literalSourceProblems = (where: SourceCase, native: Option.Option<NativeOperation>) => (source: typeof LiteralSourceSchema.Type) => pipe(literalProblems(where, source), onNative(native))

// Native strategies and literals are checked against the native field because an inapplicable interpretation must fail validation, not the run.
const sourceProblems = (bindings: CatalogBindings, scenario: Scenario, input: InputCase, native: Option.Option<NativeOperation>) => (entry: readonly [string, FieldSource]) => {
  const [field, source] = entry
  const valid = Equal.equals(input.validity, "native-valid")
  const where = SourceCase.make({ scenario: scenario.id, input: input.id, field, valid })
  const location = sourceWhere(where)

  return pipe(
    Match.value(source),
    Match.discriminatorsExhaustive("source")({
      fixture: factProblems(bindings, location),
      native: nativeSourceProblems(where, native),
      literal: literalSourceProblems(where, native),
      captured: Array.empty<string>,
    }),
  )
}

const deniedFailure = (outcome: InputCase["outcome"]) => isDenied(outcome) ? Option.some(outcome.failure) : Option.none<string>()

const declaresFailure = (failures: ReadonlyArray<string>) => (outcome: InputCase["outcome"]) => pipe(outcome, deniedFailure, Option.match({ onNone: Function.constTrue, onSome: amongst(failures) }))

const inputProblems = (bindings: CatalogBindings, application: ApplicationIR, scenario: Scenario) => (input: InputCase) => {
  const native = nativeOperation(application, input.operation)
  const missingNative = Option.isNone(native)
  const allowed = Array.contains(scenario.operations, input.operation)
  const fields = Option.match(native, { onNone: Array.empty<string>, onSome: payloadFields })
  const unknownFields = pipe(input.fields, Record.keys, missingAmong(fields))
  const failures = Option.match(native, { onNone: Array.empty<string>, onSome: nativeFailures })
  const declaredFailure = declaresFailure(failures)(input.outcome)
  const invalid = Equal.equals(input.validity, "native-invalid")
  const rejection = Equal.equals(input.outcome.kind, "rejected")
  const incoherent = !Equal.equals(invalid, rejection)
  const where = `Scenario ${scenario.id} input ${input.id}`
  const unknownField = (name: string) => `${where} field ${name} is not in the native ${input.operation} payload`

  return [
    ...problemIf(missingNative, `${where} uses missing native operation ${input.operation}`),
    ...problemIf(!allowed, `${where} uses ${input.operation} outside the scenario's operations`),
    ...Array.map(unknownFields, unknownField),
    ...problemIf(!declaredFailure, `${where} expects a failure the native ${input.operation} contract does not declare`),
    ...problemIf(incoherent, `${where} must pair native-invalid input with a rejected outcome and native-valid input with acceptance or a declared denial`),
    ...pipe(input.fields, Record.toEntries, Array.flatMap(sourceProblems(bindings, scenario, input, native))),
  ]
}

/** Maps a resource to the operation the runner captures it through, because validation must check exactly the operation the browser will call. */
type ObservationOperation = (resource: string) => string

const observable = (application: ApplicationIR, observationOperation: ObservationOperation) => (resource: string) => {
  const operation = observationOperation(resource)
  const listed = operation.endsWith(".list")

  return listed && operationIn(application)(operation)
}

const unobservableProblem = (where: string, observationOperation: ObservationOperation) => (resource: string) => {
  const operation = observationOperation(resource)

  return `${where} observes ${resource}, whose mapped operation ${operation} is not a native list operation`
}

const scenarioProblems = (catalog: Catalog, bindings: CatalogBindings, application: ApplicationIR, observationOperation: ObservationOperation) => (scenario: Scenario) => {
  const story = Array.findFirst(catalog.stories, byId(scenario.story))
  const storyMissing = Option.isNone(story)
  const actorDeclared = Array.some(catalog.actors, byId(scenario.actor))
  const actorMatches = pipe(story, Option.map(Struct.get("actor")), Option.contains(scenario.actor))
  const fixtureBound = Array.contains(bindings.fixtures, scenario.fixture)
  const scoped = Option.match(story, { onNone: Array.empty<string>, onSome: Struct.get("requirements") })
  const requirementIds = Array.map(catalog.requirements, Struct.get("id"))
  const inputIds = Array.map(scenario.inputs, Struct.get("id"))
  const missingOperations = Array.filter(scenario.operations, Predicate.not(operationIn(application)))
  const missingRequirements = missingAmong(requirementIds)(scenario.requirements)
  const unscoped = pipe(scenario.requirements, Array.filter(amongst(requirementIds)), missingAmong(scoped))
  const undeclaredInputs = missingAmong(inputIds)(scenario.required)
  const repeatedInputs = repeatedKeys(inputIds)
  const unobservable = Array.filter(scenario.observations, Predicate.not(observable(application, observationOperation)))
  const unboundProbes = missingAmong(bindings.probes)(scenario.probes)
  const where = `Scenario ${scenario.id}`
  const missingOperation = (name: string) => `${where} uses missing native operation ${name}`
  const missingRequirement = (id: string) => `${where} references missing requirement ${id}`
  const unscopedRequirement = (id: string) => `${where} references requirement ${id} outside story ${scenario.story}`
  const undeclaredInput = (id: string) => `${where} requires undeclared input ${id}`
  const repeatedInput = (id: string) => `${where} declares input ${id} more than once`
  const unobservableResource = unobservableProblem(where, observationOperation)
  const unboundProbe = (probe: string) => `${where} uses probe ${probe}, which the fixture runtime does not implement`

  return [
    ...problemIf(storyMissing, `${where} references missing story ${scenario.story}`),
    ...problemIf(!actorDeclared, `${where} references missing actor ${scenario.actor}`),
    ...problemIf(!actorMatches, `${where} actor does not match its story`),
    ...problemIf(!fixtureBound, `${where} names missing fixture binding ${scenario.fixture}`),
    ...Array.map(missingOperations, missingOperation),
    ...Array.map(missingRequirements, missingRequirement),
    ...Array.map(unscoped, unscopedRequirement),
    ...Array.map(undeclaredInputs, undeclaredInput),
    ...Array.map(repeatedInputs, repeatedInput),
    ...Array.map(unobservable, unobservableResource),
    ...Array.map(unboundProbes, unboundProbe),
    ...Array.flatMap(scenario.inputs, inputProblems(bindings, application, scenario)),
  ]
}

const decodeCatalog = Schema.decodeUnknownEffect(Catalog)
const invalidDeclaration = (error: Schema.SchemaError) => AcceptanceError.make({ boundary: "catalog", message: error.message })

/**
 * Decodes the catalog and resolves every reference against the compiled application, the runtime bindings, and the definition's
 * observation mapping because only a fully bound catalog may run.
 */
export const validateCatalog = Effect.fn("Acceptance.validateCatalog")(function* (input: unknown, bindings: CatalogBindings, application: ApplicationIR, observationOperation: ObservationOperation) {
  const catalog = yield* pipe(input, decodeCatalog, Effect.mapError(invalidDeclaration))

  const problems = [
    ...duplicateProblems(catalog),
    ...Array.flatMap(catalog.actors, actorProblems(bindings)),
    ...Array.flatMap(catalog.requirements, requirementProblems(bindings)),
    ...Array.flatMap(catalog.stories, storyProblems(catalog)),
    ...Array.flatMap(catalog.scenarios, scenarioProblems(catalog, bindings, application, observationOperation)),
  ]

  const message = Array.join(problems, "; ")

  if (Array.isReadonlyArrayNonEmpty(problems)) return yield* AcceptanceError.make({ boundary: "catalog", message })

  return catalog
})
