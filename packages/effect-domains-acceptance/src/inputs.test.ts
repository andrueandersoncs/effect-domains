import { expect, it } from "@effect/vitest"
import { Array, Context, Effect, Equal, Function, Layer, Option, Order, Predicate, Record, Schema, SchemaGetter, SchemaIssue, Struct, String as Text, pipe } from "effect"
import { Application, Part } from "effect-domains/application"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { type CodecServices, inputLayer } from "./inputs.ts"
import { AcceptanceError, type Candidate, type FieldSource, InputCandidates, InputCase, PreparedFixture, Scenario } from "./model.ts"
import { TestApplication } from "./test-application.ts"

type Strategy = Extract<FieldSource, { readonly source: "native" }>["strategy"]

/** The wire prefix is a runtime service because the generation test must prove that payload codecs encode and decode with provided services. */
class WirePrefix extends Context.Service<WirePrefix, { readonly value: string }>()("acceptance-test/WirePrefix") {}

const missingPrefix = (value: string) => new SchemaIssue.InvalidValue({ expected: "a code carrying the configured wire prefix" }, value)

const decodeWire = SchemaGetter.transformOrFail<string, string, WirePrefix>(Effect.fn("InputsTest.decodeWire")(function* (value) {
  const prefix = yield* WirePrefix
  const carried = Text.startsWith(prefix.value)(value)
  const issue = missingPrefix(value)

  if (!carried) return yield* Effect.fail(issue)

  return Text.slice(prefix.value.length)(value)
}))

const encodeWire = SchemaGetter.transformOrFail<string, string, WirePrefix>(Effect.fn("InputsTest.encodeWire")(function* (value) {
  const prefix = yield* WirePrefix

  return `${prefix.value}${value}`
}))

const codePattern = /^[A-Z]{3}$/

const wiredPattern = /^wire:[A-Z]{3}$/

const emailPattern = /^[a-z]{1,8}@example\.test$/

const CodeSchema = Schema.String.check(Schema.isPattern(codePattern))

const WireCodeSchema = pipe(Schema.String, Schema.decodeTo(CodeSchema, { decode: decodeWire, encode: encodeWire }))

const StoredCodeSchema = Schema.Struct({ code: WireCodeSchema, label: Schema.NonEmptyString })

interface StoredCode extends Schema.Schema.Type<typeof StoredCodeSchema> {}

const BoundSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))

const PlanFieldsSchema = Schema.Struct({ starts: BoundSchema, ends: BoundSchema })

interface PlanFields extends Schema.Schema.Type<typeof PlanFieldsSchema> {}

const planOrder: Schema.Annotations.Filter = { message: "a plan must end after it starts" }

const isOrdered = (plan: PlanFields) => plan.starts < plan.ends

const orderedPlan = Schema.makeFilter(isOrdered, planOrder)

const PlanSchema = PlanFieldsSchema.check(orderedPlan)

interface Tree {
  readonly label: string
  readonly children: ReadonlyArray<Tree>
}

const treeLayer = <Child extends Schema.Constraint>(child: Child) => Schema.Struct({ label: Schema.NonEmptyString, children: Schema.Array(child) })

const TreeSchema: Schema.Codec<Tree> = Schema.suspend(() => treeLayer(TreeSchema))

const EmailSchema = Schema.String.check(Schema.isPattern(emailPattern))

const ContactSchema = Schema.Struct({ email: EmailSchema })

interface Contact extends Schema.Schema.Type<typeof ContactSchema> {}

const OwnerSchema = Schema.Struct({ name: Schema.NonEmptyString, contact: ContactSchema })

interface Owner extends Schema.Schema.Type<typeof OwnerSchema> {}

const TagsSchema = Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1))

const ScoresSchema = Schema.Record(Schema.String, Schema.Int)

const PlantSchema = Schema.Struct({ owner: OwnerSchema, tags: TagsSchema, scores: ScoresSchema, tree: TreeSchema })

interface Plant extends Schema.Schema.Type<typeof PlantSchema> {}

const GeneratedIdSchema = Schema.optionalKey(Schema.Never)

const NoteSchema = Schema.Struct({ title: Schema.NonEmptyString, id: GeneratedIdSchema })

interface Note extends Schema.Schema.Type<typeof NoteSchema> {}

const impossibleCode = "exactly-this-forty-character-code-0123456"

const isImpossibleCode = (value: string) => Equal.equals(value, impossibleCode)

const OpaqueCodeSchema = Schema.String.check(Schema.makeFilter(isImpossibleCode))

const OpaqueSchema = Schema.Struct({ code: OpaqueCodeSchema })

interface Opaque extends Schema.Schema.Type<typeof OpaqueSchema> {}

const storeCode = Rpc.make("codes.store", { payload: StoredCodeSchema, success: Schema.Void })
const planPeriod = Rpc.make("periods.plan", { payload: PlanSchema, success: Schema.Void })
const plantTree = Rpc.make("trees.plant", { payload: PlantSchema, success: Schema.Void })
const recordNote = Rpc.make("notes.record", { payload: NoteSchema, success: Schema.Void })
const opaqueCode = Rpc.make("codes.opaque", { payload: OpaqueSchema, success: Schema.Void })
const generationGroup = RpcGroup.make(storeCode, planPeriod, plantTree, recordNote, opaqueCode)
const generationParts = [Part.native({ group: generationGroup, handlers: Layer.empty })]
const generationDefinition = Application.define({ name: "acceptance-generation-test", parts: generationParts })
const generationCompiler = Application.compile(generationDefinition)

// The generation application compiles synchronously because it is a pure definition whose handlers are never served.
const GenerationApplication = Effect.runSync(generationCompiler)

const wirePrefix = Context.make(WirePrefix, { value: "wire:" })

const otherPrefix = Context.make(WirePrefix, { value: "other:" })

const noServices = Context.empty()

const fixture = PreparedFixture.make({ binding: "ratings", url: "http://127.0.0.1/", actor: "rater", facts: {}, tracked: [] })

const note: FieldSource = { source: "literal", value: "Read twice" }

const nativeOf = (strategy: Strategy): FieldSource => ({ source: "native", strategy })

const literalOf = (value: unknown): FieldSource => ({ source: "literal", value })

const sampled = nativeOf("sample")

const minimumScore = nativeOf("minimum")

const nullRating = nativeOf("null")

const accepted: InputCase["outcome"] = { kind: "accepted" }

const rejected: InputCase["outcome"] = { kind: "rejected" }

const outcomeOf = (validity: InputCase["validity"]) => Equal.equals(validity, "native-valid") ? accepted : rejected

const operationCase = (operation: string) => (id: string, fields: InputCase["fields"], validity: InputCase["validity"]) => InputCase.make({
  id,
  operation,
  description: id,
  fields,
  validity,
  outcome: outcomeOf(validity),
})

const caseWith = operationCase("ratings.rate")

const ratingCase = (strategy: Strategy, validity: InputCase["validity"]) => {
  const rating = nativeOf(strategy)

  return caseWith(`rating-${strategy}`, { rating, score: minimumScore, note }, validity)
}

const scoreCase = (strategy: Strategy, validity: InputCase["validity"]) => {
  const score = nativeOf(strategy)

  return caseWith(`score-${strategy}`, { rating: nullRating, score, note }, validity)
}

const scenarioOf = (input: InputCase) => Scenario.make({
  id: input.id,
  story: "rate",
  actor: "rater",
  fixture: "ratings",
  goal: "Rate the book",
  operations: [input.operation],
  inputs: [input],
  required: [input.id],
  observations: [],
  probes: [],
  requirements: [],
  reload: false,
})

const noCandidate = AcceptanceError.make({ boundary: "test", message: "The declared case resolved no candidate" })

const candidateWith = (seed: number) => Effect.fn("InputsTest.candidateWith")(function* (input: InputCase) {
  const inputs = yield* InputCandidates
  const scenario = scenarioOf(input)
  const candidates = yield* inputs.resolve(scenario, fixture, [], seed)

  return yield* pipe(candidates, Array.head, Effect.fromOption, Effect.mapError(Function.constant(noCandidate)))
})

const ratingLayer = inputLayer(TestApplication, noServices)

const resolveCase = Function.flow(candidateWith(7), Effect.provide(ratingLayer))

const generated = (services: CodecServices, seed: number) => {
  const layer = inputLayer(GenerationApplication, services)

  return Function.flow(candidateWith(seed), Effect.provide(layer))
}

const resolveGenerated = generated(wirePrefix, 7)

const inputOf = Struct.get<Candidate, "input">("input")

const fieldOf = (field: string) => Function.flow(resolveCase, Effect.map(Function.flow(inputOf, Record.get(field))))

const ratingOf = fieldOf("rating")

const scoreOf = fieldOf("score")

const one = Option.some(1)
const five = Option.some(5)
const absent = Option.some(null)
const zero = Option.some(0)
const six = Option.some(6)
const half = Option.some(1.5)

const minimumRating = ratingCase("minimum", "native-valid")
const maximumRating = ratingCase("maximum", "native-valid")
const nullableRating = ratingCase("null", "native-valid")
const maximumScore = scoreCase("maximum", "native-valid")
const belowRating = ratingCase("below", "native-invalid")
const aboveScore = scoreCase("above", "native-invalid")
const fractionalRating = ratingCase("fractional", "native-invalid")
const nullScore = scoreCase("null", "native-valid")
const noteMinimum = caseWith("note-minimum", { rating: nullRating, score: minimumScore, note: minimumScore }, "native-valid")

const boundsTest = Effect.gen(function* () {
  const minimum = yield* ratingOf(minimumRating)
  const maximum = yield* ratingOf(maximumRating)
  const nullable = yield* ratingOf(nullableRating)
  const score = yield* scoreOf(maximumScore)

  expect(minimum).toEqual(one)
  expect(maximum).toEqual(five)
  expect(nullable).toEqual(absent)
  expect(score).toEqual(five)
})

const outsideTest = Effect.gen(function* () {
  const below = yield* resolveCase(belowRating)
  const above = yield* scoreOf(aboveScore)
  const fractional = yield* ratingOf(fractionalRating)
  const belowValue = Record.get(below.input, "rating")

  expect(belowValue).toEqual(zero)
  expect(below.validity).toBe("native-invalid")
  expect(above).toEqual(six)
  expect(fractional).toEqual(half)
})

const unsupportedTest = Effect.gen(function* () {
  const nullFailure = yield* pipe(nullScore, resolveCase, Effect.flip)
  const textFailure = yield* pipe(noteMinimum, resolveCase, Effect.flip)

  expect(nullFailure.boundary).toBe("inputs.unsupported")
  expect(textFailure.boundary).toBe("inputs.unsupported")
  expect(nullFailure.message).toBe("Native null strategy needs ratings.rate.score to be an untransformed nullable field")
  expect(textFailure.message).toBe("Native bound strategies need ratings.rate.note to be an untransformed number or nullable number")
})

const seeds = [1, 2, 3, 4, 5, 6, 7, 8]

const planCase = operationCase("periods.plan")

const decodePlan = Schema.decodeUnknownEffect(PlanSchema)

const planOf = Function.flow(inputOf, decodePlan)

const sampledPlan = planCase("plan-sample", { starts: sampled, ends: sampled }, "native-valid")

const sampledPlanAt = (seed: number) => pipe(sampledPlan, generated(wirePrefix, seed), Effect.flatMap(planOf))

const lateStart = literalOf(500)

const lastStart = literalOf(1000)

const latePlan = planCase("plan-late", { starts: lateStart, ends: sampled }, "native-valid")

const unsatisfiablePlan = planCase("plan-unsatisfiable", { starts: lastStart, ends: sampled }, "native-valid")

const reversedPlan = planCase("plan-reversed", { starts: lastStart, ends: sampled }, "native-invalid")

const correlatedTest = Effect.gen(function* () {
  const plans = yield* Effect.forEach(seeds, sampledPlanAt)
  const lateCandidate = yield* resolveGenerated(latePlan)
  const late = yield* planOf(lateCandidate)
  const exhausted = yield* pipe(unsatisfiablePlan, resolveGenerated, Effect.flip)
  const reversed = yield* resolveGenerated(reversedPlan)
  const allOrdered = Array.every(plans, isOrdered)

  expect(allOrdered).toBe(true)
  expect(late.starts).toBe(500)
  expect(late.ends).toBeGreaterThan(500)
  expect(exhausted.boundary).toBe("inputs.exhausted")
  expect(exhausted.message).toContain("200 seeded attempts")
  expect(reversed.validity).toBe("native-invalid")
  expect(reversed.nativeValidation).toContain("a plan must end after it starts")
})

const plantCase = operationCase("trees.plant")

const decodePlant = Schema.decodeUnknownEffect(PlantSchema)

const treeDepth = (tree: Tree): number => {
  const depths = Array.map(tree.children, treeDepth)
  const deepest = Array.reduce(depths, 0, Order.max(Order.Number))

  return deepest + 1
}

const isLabelled = (tree: Tree): boolean => {
  const labelled = Text.isNonEmpty(tree.label)

  return labelled && Array.every(tree.children, isLabelled)
}

const hasLabelledTree = (plant: Plant) => isLabelled(plant.tree)

const plantFields = { owner: sampled, tags: sampled, scores: sampled, tree: sampled }

const sampledPlant = plantCase("plant-sample", plantFields, "native-valid")

const plantAt = (seed: number) => generated(wirePrefix, seed)(sampledPlant)

const plantOf = Function.flow(inputOf, decodePlant)

const hasPatternedEmail = (plant: Plant) => emailPattern.test(plant.owner.contact.email)

const hasTags = (plant: Plant) => Array.isReadonlyArrayNonEmpty(plant.tags)

const isShallow = (plant: Plant) => {
  const depth = treeDepth(plant.tree)

  return depth <= 4
}

const hasScoresRecord = Function.flow(inputOf, Record.get("scores"), Option.exists(Predicate.isObject))

const structuredTest = Effect.gen(function* () {
  const candidates = yield* Effect.forEach(seeds, plantAt)
  const plants = yield* Effect.forEach(candidates, plantOf)
  const emails = Array.every(plants, hasPatternedEmail)
  const tags = Array.every(plants, hasTags)
  const shallow = Array.every(plants, isShallow)
  const records = Array.every(candidates, hasScoresRecord)
  const labelled = Array.every(plants, hasLabelledTree)

  expect(emails).toBe(true)
  expect(tags).toBe(true)
  expect(shallow).toBe(true)
  expect(records).toBe(true)
  expect(labelled).toBe(true)
})

const noteCase = operationCase("notes.record")

const forgedId = literalOf("forged-id")

const sampledNote = noteCase("note-sample", { title: sampled }, "native-valid")

const forgedNote = noteCase("note-forged", { title: sampled, id: forgedId }, "native-invalid")

const decodeNote = Schema.decodeUnknownEffect(NoteSchema)

const generatedFieldTest = Effect.gen(function* () {
  const candidate = yield* resolveGenerated(sampledNote)
  const forged = yield* resolveGenerated(forgedNote)
  const fields = Record.keys(candidate.input)
  const decoded = yield* decodeNote(candidate.input)
  const titled = Text.isNonEmpty(decoded.title)

  expect(fields).toEqual(["title"])
  expect(titled).toBe(true)
  expect(forged.validity).toBe("native-invalid")
  expect(forged.input.id).toBe("forged-id")
})

const opaqueCase = operationCase("codes.opaque")("opaque", { code: sampled }, "native-valid")

const opaqueTest = Effect.gen(function* () {
  const failure = yield* pipe(opaqueCase, resolveGenerated, Effect.flip)

  expect(failure.boundary).toBe("inputs.exhausted")
  expect(failure.message).toContain("200 seeded attempts")
})

const codeCase = operationCase("codes.store")

const codeOf = Function.flow(inputOf, Record.get("code"))

const wiredCode = literalOf("wire:XYZ")

const bareCode = literalOf("XYZ")

const sampledCode = codeCase("code-sample", { code: sampled, label: note }, "native-valid")

const wiredCase = codeCase("code-wired", { code: wiredCode, label: note }, "native-valid")

const bareCase = codeCase("code-bare", { code: bareCode, label: note }, "native-invalid")

const elsewhereCase = codeCase("code-elsewhere", { code: wiredCode, label: note }, "native-invalid")

const isWired = (value: unknown) => Predicate.isString(value) && wiredPattern.test(value)

const wiredValue = Option.some("wire:XYZ")

const resolveElsewhere = generated(otherPrefix, 7)

const serviceCodecTest = Effect.gen(function* () {
  const sampledCandidate = yield* resolveGenerated(sampledCode)
  const wired = yield* resolveGenerated(wiredCase)
  const bare = yield* resolveGenerated(bareCase)
  const elsewhere = yield* resolveElsewhere(elsewhereCase)
  const sampledValue = codeOf(sampledCandidate)
  const wiredInput = codeOf(wired)
  const encoded = Option.exists(sampledValue, isWired)

  expect(encoded).toBe(true)
  expect(wiredInput).toEqual(wiredValue)
  expect(bare.nativeValidation).toContain("configured wire prefix")
  expect(elsewhere.validity).toBe("native-invalid")
})

const replayScenario = scenarioOf(latePlan)

const generationLayer = inputLayer(GenerationApplication, wirePrefix)

const replayed = Effect.fn("InputsTest.replayed")(function* (recorded: Candidate) {
  const inputs = yield* InputCandidates

  return yield* inputs.replay(replayScenario, [recorded], fixture, [])
}, Effect.provide(generationLayer))

const replayTest = Effect.gen(function* () {
  const recorded = yield* resolveGenerated(latePlan)
  const candidates = yield* replayed(recorded)
  const inputs = Array.map(candidates, inputOf)

  expect(inputs).toEqual([recorded.input])
})

it.effect("native bound strategies read inclusive integer bounds from the native field", Function.constant(boundsTest))
it.effect("strategies outside the bounds produce native-invalid candidates", Function.constant(outsideTest))
it.effect("strategies on fields without the required native shape fail instead of guessing", Function.constant(unsupportedTest))
it.effect("whole-payload samples satisfy struct-level correlated checks or report bounded exhaustion", Function.constant(correlatedTest))
it.effect("nested objects, arrays, records, and bounded recursive values are sampled natively", Function.constant(structuredTest))
it.effect("generated and trusted fields are excluded from samples and rejected when supplied", Function.constant(generatedFieldTest))
it.effect("opaque custom checks are enforced by the bounded loop and report inputs.exhausted", Function.constant(opaqueTest))
it.effect("payload codecs encode and decode with the runtime-provided services", Function.constant(serviceCodecTest))
it.effect("replay reuses the recorded whole-payload sample concretely", Function.constant(replayTest))
