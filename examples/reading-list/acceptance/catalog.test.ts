import { expect, it } from "@effect/vitest"
import { Array, Effect, Equal, Function, Schema, String as Text, Struct, pipe } from "effect"
import { CatalogBindings, validateCatalog } from "@effect-domains/acceptance/catalog"
import { Catalog, FixtureRuntime } from "@effect-domains/acceptance/model"
import { ReadingListApplication } from "../application.ts"
import { observationOperation, readingListCatalog } from "./catalog.ts"
import { evaluatorNames } from "./evaluation.ts"
import { fixtureLayer } from "./fixture.ts"

const DeclarationSchema = Schema.toEncoded(Catalog)

type Declaration = typeof DeclarationSchema.Type

const bindings = Effect.gen(function* () {
  const runtime = yield* FixtureRuntime

  return CatalogBindings.make({ evaluators: evaluatorNames, fixtures: runtime.bindings, actors: runtime.actors, facts: runtime.facts, probes: runtime.probes })
})

const replacing = <Key extends "actors" | "requirements" | "scenarios">(key: Key) => (entry: Declaration[Key][number]) => DeclarationSchema.make({ ...readingListCatalog, [key]: [entry] })
const withActor = replacing("actors")
const withRequirement = replacing("requirements")
const withScenario = replacing("scenarios")
const containsFragment = ([message, fragment]: readonly [string, string]) => Text.includes(fragment)(message)

const fragmentsFound = (messages: ReadonlyArray<string>, fragments: ReadonlyArray<string>) => {
  const pairs = Array.zip(messages, fragments)
  const found = Array.map(pairs, containsFragment)
  const expectedCount = Array.length(fragments)
  const observedCount = Array.length(messages)
  const sameLength = Equal.equals(expectedCount, observedCount)

  return sameLength && Array.every(found, Boolean)
}

const rejectionOf = (bound: CatalogBindings) => Effect.fn("ReadingListCatalogTest.rejection")(function* (declaration: Declaration) {
  const failure = yield* pipe(validateCatalog(declaration, bound, ReadingListApplication, observationOperation), Effect.flip)

  expect(failure.boundary).toBe("catalog")

  return failure.message
})

const inputCount = (scenario: Catalog["scenarios"][number]) => Array.length(scenario.inputs)

const authoredCatalogTest = Effect.gen(function* () {
  const bound = yield* bindings
  const catalog = yield* validateCatalog(readingListCatalog, bound, ReadingListApplication, observationOperation)
  const scenarioIds = Array.map(catalog.scenarios, Struct.get("id"))
  const fixtures = Array.map(catalog.scenarios, Struct.get("fixture"))
  const inputCounts = Array.map(catalog.scenarios, inputCount)
  const createFixtures = Array.replicate("isolated-reading-list", 3)
  const targetFixtures = Array.replicate("isolated-reading-list-target", 6)
  const singleInputs = Array.replicate(1, 9)
  const ids = Array.map(catalog.requirements, Struct.get("id"))
  const evaluators = Array.map(catalog.requirements, Struct.get("evaluator"))

  expect(scenarioIds).toEqual(["create-sample", "create-null", "create-omitted", "rating-minimum", "rating-maximum", "rating-null", "rating-below", "rating-above", "rating-fractional"])
  expect(fixtures).toEqual([...createFixtures, ...targetFixtures])
  expect(inputCounts).toEqual(singleInputs)
  expect(ids).toEqual(["RL-CREATE", "RL-RELOAD", "RL-RATING", "RL-REJECT", "RL-PRESERVE"])
  expect(evaluators).toEqual(["created-values", "reload-visible", "accepted-rating", "rejection-unchanged", "sentinel-unchanged"])
})

const bindingRejectionTest = Effect.gen(function* () {
  const bound = yield* bindings
  const rejection = rejectionOf(bound)
  const reader = yield* pipe(readingListCatalog.actors, Array.head, Effect.fromOption)
  const createSample = yield* pipe(readingListCatalog.scenarios, Array.head, Effect.fromOption)
  const createInput = yield* pipe(createSample.inputs, Array.head, Effect.fromOption)
  const createdValues = yield* pipe(readingListCatalog.requirements, Array.head, Effect.fromOption)
  const unboundActor = withActor({ ...reader, binding: "admin-session" })
  const unknownOperation = withScenario({ ...createSample, operations: ["books.patch"], inputs: [{ ...createInput, operation: "books.patch" }] })
  const unboundFixture = withScenario({ ...createSample, fixture: "missing-fixture" })
  const unknownFact = withScenario({ ...createSample, inputs: [{ ...createInput, fields: { ...createInput.fields, title: { source: "fixture", fact: "obsolete.title", offset: 0 } } }] })
  const unscopedRequirement = withScenario({ ...createSample, requirements: ["RL-REJECT"] })
  const obsoleteEvaluator = withRequirement({ ...createdValues, evaluator: "obsolete" })
  const duplicateRequirement = DeclarationSchema.make({ ...readingListCatalog, requirements: [createdValues, ...readingListCatalog.requirements] })
  const declarations = [unboundActor, unknownOperation, unboundFixture, unknownFact, unscopedRequirement, obsoleteEvaluator, duplicateRequirement]
  const messages = yield* Effect.forEach(declarations, rejection)

  const fragments = [
    "Actor reader names missing actor binding admin-session",
    "Scenario create-sample uses missing native operation books.patch",
    "Scenario create-sample names missing fixture binding missing-fixture",
    "uses unknown fixture fact obsolete.title",
    "Scenario create-sample references requirement RL-REJECT outside story record-reading",
    "Requirement RL-CREATE names unavailable evaluator obsolete",
    "Duplicate declaration id: RL-CREATE",
  ]

  const found = fragmentsFound(messages, fragments)

  expect(found).toBe(true)
})

const outcomeRejectionTest = Effect.gen(function* () {
  const bound = yield* bindings
  const rejection = rejectionOf(bound)
  const createSample = yield* pipe(readingListCatalog.scenarios, Array.head, Effect.fromOption)
  const ratingBelow = yield* pipe(readingListCatalog.scenarios, Array.get(6), Effect.fromOption)
  const createInput = yield* pipe(createSample.inputs, Array.head, Effect.fromOption)
  const belowInput = yield* pipe(ratingBelow.inputs, Array.head, Effect.fromOption)
  const acceptedBoundary = withScenario({ ...ratingBelow, inputs: [{ ...belowInput, outcome: { kind: "accepted" } }] })
  const rejectedCreation = withScenario({ ...createSample, inputs: [{ ...createInput, outcome: { kind: "rejected" } }] })
  const undeclaredRequired = withScenario({ ...createSample, required: ["missing-input"] })
  const declarations = [acceptedBoundary, rejectedCreation, undeclaredRequired]
  const messages = yield* Effect.forEach(declarations, rejection)

  const fragments = [
    "Scenario rating-below input below must pair native-invalid input with a rejected outcome",
    "Scenario create-sample input sample must pair native-invalid input with a rejected outcome",
    "Scenario create-sample requires undeclared input missing-input",
  ]

  const found = fragmentsFound(messages, fragments)

  expect(found).toBe(true)
})

const provided = <A, E>(test: Effect.Effect<A, E, FixtureRuntime>) => Effect.provide(test, fixtureLayer)

const authoredCatalog = provided(authoredCatalogTest)
const bindingRejection = provided(bindingRejectionTest)
const outcomeRejection = provided(outcomeRejectionTest)

it.effect("the authored catalog resolves its bindings against the compiled application", Function.constant(authoredCatalog))
it.effect("declarations reject missing operations, fixtures, facts, evaluators, actors, duplicates, and unscoped requirements", Function.constant(bindingRejection))
it.effect("contradictory validity and outcome declarations and undeclared required inputs remain rejected", Function.constant(outcomeRejection))
