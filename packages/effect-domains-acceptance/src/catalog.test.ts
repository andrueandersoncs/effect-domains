import { expect, it } from "@effect/vitest"
import { Array, Effect, Function, Schema, Struct, pipe } from "effect"
import { Application, Part } from "effect-domains/application"
import { Command } from "effect-domains/command"
import { CatalogBindings, validateCatalog } from "./catalog.ts"
import { Catalog } from "./model.ts"
import { TestApplication, listOperation } from "./test-application.ts"

const DeclarationSchema = Schema.toEncoded(Catalog)

type Declaration = typeof Catalog.Encoded
type ScenarioDeclaration = Declaration["scenarios"][number]
type InputDeclaration = ScenarioDeclaration["inputs"][number]
type FieldDeclaration = InputDeclaration["fields"][string]
type FieldDeclarations = InputDeclaration["fields"]
type StrategyDeclaration = Extract<FieldDeclaration, { readonly source: "native" }>["strategy"]

const bindings = CatalogBindings.make({
  evaluators: ["check"],
  fixtures: ["fixture-a"],
  actors: ["public"],
  facts: ["target.id"],
  probes: ["status"],
})

const literal = (value: unknown): FieldDeclaration => ({ source: "literal", value })
const native = (strategy: StrategyDeclaration): FieldDeclaration => ({ source: "native", strategy })
const two = literal(2)
const three = literal(3)
const nine = literal(9)
const numericNote = literal(3)
const plain = literal("Plain")
const happy = literal("happy")
const readTwice = literal("Read twice")
const confirmed = literal(true)
const nativeMinimum = native("minimum")
const nativeNull = native("null")
const nativeAbove = native("above")
const nativeSample = native("sample")
const ghostFact: FieldDeclaration = { source: "fixture", fact: "ghost.fact", offset: 0 }
const accepted: InputDeclaration["outcome"] = { kind: "accepted" }
const rateFields: FieldDeclarations = { rating: three, score: three, note: readTwice }
const rateCase: InputDeclaration = { id: "rate", operation: "ratings.rate", description: "Rate the book", fields: rateFields, validity: "native-valid", outcome: accepted }

const scenario: ScenarioDeclaration = {
  id: "scenario",
  story: "story",
  actor: "person",
  fixture: "fixture-a",
  goal: "Rate the book.",
  operations: ["ratings.rate"],
  inputs: [rateCase],
  required: ["rate"],
  observations: [],
  probes: ["status"],
  requirements: ["REQ-CHECK"],
  reload: false,
}

const tiny = DeclarationSchema.make({
  id: "tiny",
  actors: [{ id: "person", binding: "public", description: "An ordinary person." }],
  requirements: [{ id: "REQ-CHECK", text: "The rating holds.", evaluator: "check" }, { id: "REQ-OTHER", text: "Another obligation.", evaluator: "check" }],
  stories: [{ id: "story", text: "As a person, I want to rate a book.", actor: "person", requirements: ["REQ-CHECK"] }],
  scenarios: [scenario],
})

const withScenario = (declared: ScenarioDeclaration) => DeclarationSchema.make({ ...tiny, scenarios: [declared] })

const withInput = (input: InputDeclaration) => DeclarationSchema.make({ ...tiny, scenarios: [{ ...scenario, inputs: [input] }] })

const withFields = (fields: FieldDeclarations) => DeclarationSchema.make({ ...tiny, scenarios: [{ ...scenario, inputs: [{ ...rateCase, fields }] }] })

const validated = (declaration: Declaration) => validateCatalog(declaration, bindings, TestApplication, listOperation)

const rejection = Effect.fn("CatalogTest.rejection")(function* (declaration: Declaration) {
  const failure = yield* pipe(declaration, validated, Effect.flip)

  expect(failure.boundary).toBe("catalog")

  return failure.message
})

const unreported = (report: string) => (fragment: string) => !report.includes(fragment)

/** Every expected fragment must appear in the joined rejection messages because each rejection names its scenario, input, and field. */
const unreportedAmong = Effect.fn("CatalogTest.unreportedAmong")(function* (declarations: ReadonlyArray<Declaration>, fragments: ReadonlyArray<string>) {
  const messages = yield* Effect.forEach(declarations, rejection)
  const report = Array.join(messages, "\n")

  return Array.filter(fragments, unreported(report))
})

const validCatalogTest = Effect.gen(function* () {
  const catalog = yield* validated(tiny)
  const scenarios = Array.map(catalog.scenarios, Struct.get("id"))

  expect(catalog.id).toBe("tiny")
  expect(scenarios).toEqual(["scenario"])
})

const clashingActor = { id: "REQ-CHECK", binding: "public", description: "A clash." }
const adminActor = { id: "person", binding: "admin", description: "An administrator." }
const ghostEvaluator = { id: "REQ-CHECK", text: "The rating holds.", evaluator: "ghost" }
const strayStory = { id: "story", text: "As nobody.", actor: "nobody", requirements: ["REQ-GHOST"] }

const gappedScenario: ScenarioDeclaration = {
  ...scenario,
  story: "missing-story",
  actor: "stranger",
  fixture: "fixture-z",
  operations: ["ratings.rate", "ratings.erase"],
  required: ["rate", "ghost-input"],
  observations: ["ratings"],
  probes: ["telepathy"],
  requirements: ["REQ-GHOST"],
}

const unscopedScenario: ScenarioDeclaration = { ...scenario, requirements: ["REQ-OTHER"] }
const operationlessScenario: ScenarioDeclaration = { ...scenario, operations: [] }
const repeatedScenario: ScenarioDeclaration = { ...scenario, inputs: [rateCase, rateCase] }
const moodFields: FieldDeclarations = { ...rateFields, mood: happy }
const ghostFactFields: FieldDeclarations = { ...rateFields, score: ghostFact }
const teapotCase: InputDeclaration = { ...rateCase, outcome: { kind: "denied", failure: "Teapot" } }
const incoherentCase: InputDeclaration = { ...rateCase, validity: "native-invalid" }

const referenceRejectionTest = Effect.gen(function* () {
  const declarations = [
    DeclarationSchema.make({ ...tiny, actors: [...tiny.actors, clashingActor] }),
    DeclarationSchema.make({ ...tiny, actors: [adminActor] }),
    DeclarationSchema.make({ ...tiny, requirements: [ghostEvaluator] }),
    DeclarationSchema.make({ ...tiny, stories: [strayStory] }),
    withScenario(gappedScenario),
    withScenario(unscopedScenario),
    withScenario(operationlessScenario),
    withScenario(repeatedScenario),
    withFields(moodFields),
    withFields(ghostFactFields),
    withInput(teapotCase),
    withInput(incoherentCase),
  ]

  const fragments = [
    "Duplicate declaration id: REQ-CHECK",
    "Actor person names missing actor binding admin",
    "Requirement REQ-CHECK names unavailable evaluator ghost",
    "Story story references missing actor nobody",
    "Story story references missing requirement REQ-GHOST",
    "Scenario scenario references missing story missing-story",
    "Scenario scenario references missing actor stranger",
    "Scenario scenario actor does not match its story",
    "Scenario scenario names missing fixture binding fixture-z",
    "Scenario scenario uses missing native operation ratings.erase",
    "Scenario scenario references missing requirement REQ-GHOST",
    "Scenario scenario requires undeclared input ghost-input",
    "Scenario scenario observes ratings, whose mapped operation ratings.list is not a native list operation",
    "Scenario scenario uses probe telepathy, which the fixture runtime does not implement",
    "Scenario scenario references requirement REQ-OTHER outside story story",
    "Scenario scenario input rate uses ratings.rate outside the scenario's operations",
    "Scenario scenario declares input rate more than once",
    "Scenario scenario input rate field mood is not in the native ratings.rate payload",
    "Scenario scenario input rate field score uses unknown fixture fact ghost.fact",
    "Scenario scenario input rate expects a failure the native ratings.rate contract does not declare",
    "Scenario scenario input rate must pair native-invalid input with a rejected outcome",
  ]

  const missing = yield* unreportedAmong(declarations, fragments)

  expect(missing).toEqual([])
})

const deniedCase: InputDeclaration = { ...rateCase, outcome: { kind: "denied", failure: "RatingUnavailable" } }
const aboveCase: InputDeclaration = { ...rateCase, fields: { ...rateFields, score: nativeAbove }, validity: "native-invalid", outcome: { kind: "rejected" } }

const declaredDenialTest = Effect.gen(function* () {
  const declarations = [withInput(deniedCase), withInput(aboveCase)]
  const catalogs = yield* Effect.forEach(declarations, validated)

  expect(catalogs).toHaveLength(2)
})

class TagUnavailable extends Schema.TaggedError<TagUnavailable>()("TagUnavailable", {}) {}

const confirmedOnly = (flag: boolean) => flag
const confirmedFilter = Schema.makeFilter(confirmedOnly)

// The confirmation carries a custom check without an arbitrary constraint because the interpreter cannot sample such a payload with bounded effort.
const ConfirmationSchema = Schema.Boolean.check(confirmedFilter)

const TagPayloadSchema = Schema.Struct({
  status: Schema.Literals(["open", "held", "closed"]),
  confirmed: ConfirmationSchema,
})

interface TagPayload extends Schema.Schema.Type<typeof TagPayloadSchema> {}

const tag = Command.family("tickets.", TagUnavailable).define({ name: "tag", payload: TagPayloadSchema, success: Schema.Boolean })

const tagHandler = Command.implement(tag, Effect.fn("CatalogTest.tag")(function* (payload: TagPayload) {
  return yield* Effect.succeed(payload.confirmed)
}))

const TicketCommands = Command.bundle(tagHandler)
const ticketPart = Part.command(TicketCommands)
const ticketDefinition = Application.define({ name: "catalog-ticket-test", parts: [ticketPart] })
const compiledTickets = Application.compile(ticketDefinition)

// The ticket application compiles synchronously because it is a pure definition without services.
const TicketApplication = Effect.runSync(compiledTickets)

const ticketCase: InputDeclaration = { id: "tag", operation: "tickets.tag", description: "Tag a ticket", fields: { status: nativeSample, confirmed }, validity: "native-valid", outcome: accepted }
const ticketScenario: ScenarioDeclaration = { ...scenario, operations: ["tickets.tag"], inputs: [ticketCase], required: ["tag"] }
const textBoundFields: FieldDeclarations = { rating: two, score: two, note: nativeMinimum }
const unnullableFields: FieldDeclarations = { rating: two, score: nativeNull, note: plain }
const outOfRangeFields: FieldDeclarations = { rating: two, score: nine, note: plain }
const mistypedFields: FieldDeclarations = { rating: two, score: two, note: numericNote }

const unsupportedInterpretationTest = Effect.gen(function* () {
  const declarations = [withFields(textBoundFields), withFields(unnullableFields), withFields(outOfRangeFields), withFields(mistypedFields)]
  const ticketCatalog = withScenario(ticketScenario)
  const unsampled = validateCatalog(ticketCatalog, bindings, TicketApplication, listOperation)
  const unsampleable = yield* Effect.flip(unsampled)

  const fragments = [
    "Scenario scenario input rate field note requests native minimum, which the interpreter cannot apply to ratings.rate.note: Native bound strategies need ratings.rate.note to be an untransformed number or nullable number",
    "Scenario scenario input rate field score requests native null, which the interpreter cannot apply to ratings.rate.score: Native null strategy needs ratings.rate.score to be an untransformed nullable field",
    "Scenario scenario input rate field score declares a literal the native ratings.rate.score schema does not decode although the input is native-valid: ",
    "Scenario scenario input rate field note declares a literal the native ratings.rate.note schema does not decode although the input is native-valid: ",
  ]

  const missing = yield* unreportedAmong(declarations, fragments)

  expect(missing).toEqual([])
  expect(unsampleable.message).toContain("Scenario scenario input tag field status requests native sample, which the interpreter cannot apply to tickets.tag.status: Native tickets.tag payload has a custom check without an arbitrary constraint")
})

it.effect("a fully bound catalog validates", Function.constant(validCatalogTest))
it.effect("missing, duplicate, and unknown references are rejected with actionable messages", Function.constant(referenceRejectionTest))
it.effect("declared denials and native-invalid rejections validate", Function.constant(declaredDenialTest))
it.effect("native strategies and native-valid literals the native field cannot carry are rejected with scenario, input, field, and reason", Function.constant(unsupportedInterpretationTest))
