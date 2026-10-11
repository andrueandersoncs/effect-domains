import { expect, it } from "@effect/vitest"
import { Array, Effect, Equal, Function, Schema, String as Text, Struct, pipe } from "effect"
import { CatalogBindings, validateCatalog } from "@effect-domains/acceptance/catalog"
import { Catalog, FixtureRuntime } from "@effect-domains/acceptance/model"
import { platformObligations } from "@effect-domains/acceptance/obligations"
import { ReadingListApplication } from "../application.ts"
import { readingListCatalog } from "./catalog.ts"
import { evaluatorRevisions } from "./evaluation.ts"
import { fixtureLayer } from "./fixture.ts"

const DeclarationSchema = Schema.toEncoded(Catalog)

type Declaration = typeof DeclarationSchema.Type

const bindings = Effect.gen(function* () {
  const runtime = yield* FixtureRuntime

  return CatalogBindings.make({ evaluators: evaluatorRevisions, fixtures: runtime.bindings, actors: runtime.actors, facts: runtime.facts, probes: runtime.probes, catalogs: [platformObligations] })
})

const replacing = <Key extends "actors" | "capabilities" | "requirements" | "stories" | "scenarios">(key: Key) => (entry: Declaration[Key][number]) => DeclarationSchema.make({ ...readingListCatalog, [key]: [entry] })
const withActor = replacing("actors")
const withCapability = replacing("capabilities")
const withRequirement = replacing("requirements")
const withStory = replacing("stories")
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
  const failure = yield* pipe(validateCatalog(declaration, bound, ReadingListApplication), Effect.flip)

  expect(failure.boundary).toBe("catalog")

  return failure.message
})

const inputCount = (scenario: Catalog["scenarios"][number]) => Array.length(scenario.inputs)
const isPreserve = (requirement: Catalog["requirements"][number]) => Equal.equals(requirement.id, "RL-PRESERVE")

const authoredCatalogTest = Effect.gen(function* () {
  const bound = yield* bindings
  const { catalog, requirements, assessments } = yield* validateCatalog(readingListCatalog, bound, ReadingListApplication)
  const assessed = yield* pipe(assessments, Array.head, Effect.fromOption)
  const assessmentCount = Array.length(assessments)
  const scenarioIds = Array.map(catalog.scenarios, Struct.get("id"))
  const fixtures = Array.map(catalog.scenarios, Struct.get("fixture"))
  const inputCounts = Array.map(catalog.scenarios, inputCount)
  const createFixtures = Array.replicate("isolated-reading-list", 3)
  const targetFixtures = Array.replicate("isolated-reading-list-target", 6)
  const singleInputs = Array.replicate(1, 9)
  const references = Array.map(requirements, Struct.get("reference"))
  const evaluators = Array.map(requirements, Struct.get("evaluator"))
  const preserve = yield* pipe(catalog.requirements, Array.findFirst(isPreserve), Effect.fromOption)
  const refinement = yield* Effect.fromOption(preserve.refines)

  expect(scenarioIds).toEqual(["create-sample", "create-null", "create-omitted", "rating-minimum", "rating-maximum", "rating-null", "rating-below", "rating-above", "rating-fractional"])
  expect(fixtures).toEqual([...createFixtures, ...targetFixtures])
  expect(inputCounts).toEqual(singleInputs)
  expect(catalog.imports).toEqual([{ alias: "platform", catalog: "effect-domains-platform-obligations", revision: "1" }])
  expect(references).toEqual(["RL-CREATE", "RL-RELOAD", "RL-PRESERVE", "RL-RATING", "RL-REJECT"])
  expect(evaluators).toEqual(["created-values", "reload-visible", "sentinel-unchanged", "accepted-rating", "rejection-unchanged"])
  expect(refinement.requirement).toBe("platform:PLATFORM-PRESERVE")
  expect(refinement.arguments).toEqual({ scope: "the unrelated sentinel book" })
  expect(assessmentCount).toBe(1)
  expect(assessed.reference).toBe("RL-REJECT-CLARITY")
  expect(assessed.rubric.threshold).toBe("understandable")
})

const missingRegistryTest = Effect.gen(function* () {
  const bound = yield* bindings
  const unregistered = CatalogBindings.make({ ...bound, catalogs: [] })
  const failure = yield* pipe(validateCatalog(readingListCatalog, unregistered, ReadingListApplication), Effect.flip)

  expect(failure.message).toContain("Missing import platform (effect-domains-platform-obligations@1)")
  expect(failure.message).toContain("Requirement RL-PRESERVE refines an unresolved requirement: Unknown import alias platform")
})

const bindingRejectionTest = Effect.gen(function* () {
  const bound = yield* bindings
  const rejection = rejectionOf(bound)
  const recordBook = yield* pipe(readingListCatalog.capabilities, Array.head, Effect.fromOption)
  const reader = yield* pipe(readingListCatalog.actors, Array.head, Effect.fromOption)
  const createSample = yield* pipe(readingListCatalog.scenarios, Array.head, Effect.fromOption)
  const createInput = yield* pipe(createSample.inputs, Array.head, Effect.fromOption)
  const createdValues = yield* pipe(readingListCatalog.requirements, Array.head, Effect.fromOption)
  const unknownOperation = withCapability({ ...recordBook, operations: ["books.patch"] })
  const obsoleteResource = withCapability({ ...recordBook, resource: "obsolete-books" })
  const unboundActor = withActor({ ...reader, binding: "admin-session" })
  const unboundOperation = withScenario({ ...createSample, operations: ["books.remove"], inputs: [{ ...createInput, operation: "books.remove" }] })
  const unboundFixture = withScenario({ ...createSample, fixture: "missing-fixture" })
  const unboundText = withScenario({ ...createSample, inputs: [{ ...createInput, fields: { ...createInput.fields, title: { source: "text", fixture: "missing-text-fixture", field: "title" } } }] })
  const unknownFact = withScenario({ ...createSample, inputs: [{ ...createInput, fields: { ...createInput.fields, title: { source: "fixture", fact: "obsolete.title", offset: 0 } } }] })
  const unscopedRequirement = withScenario({ ...createSample, requirements: ["RL-REJECT"] })
  const obsoleteEvaluator = withRequirement({ ...createdValues, evaluatorRevision: "obsolete" })
  const declarations = [unknownOperation, obsoleteResource, unboundActor, unboundOperation, unboundFixture, unboundText, unknownFact, unscopedRequirement, obsoleteEvaluator]
  const messages = yield* Effect.forEach(declarations, rejection)

  const fragments = [
    "Missing native operation books.patch",
    "Missing resource obsolete-books",
    "Missing actor binding admin-session",
    "Operation books.remove in create-sample is not bound through the story's capabilities",
    "Missing fixture binding missing-fixture",
    "Missing text fixture field missing-text-fixture.title",
    "Unknown fixture fact obsolete.title",
    "Requirement RL-REJECT is not scoped to story record-reading",
    "Unavailable evaluator created-values@obsolete",
  ]

  const found = fragmentsFound(messages, fragments)

  expect(found).toBe(true)
})

const readinessRejectionTest = Effect.gen(function* () {
  const bound = yield* bindings
  const rejection = rejectionOf(bound)
  const createdValues = yield* pipe(readingListCatalog.requirements, Array.head, Effect.fromOption)
  const rememberBooks = yield* pipe(readingListCatalog.needs, Array.head, Effect.fromOption)
  const recordReading = yield* pipe(readingListCatalog.stories, Array.head, Effect.fromOption)
  const duplicateNeed = DeclarationSchema.make({ ...readingListCatalog, needs: [rememberBooks, rememberBooks] })
  const undecidedStory = withStory({ ...recordReading, openDecisions: ["May we weaken rejected-attempt preservation?"] })
  const proposedCatalog = DeclarationSchema.make({ ...readingListCatalog, approval: "proposed" })
  const proposedRequirement = withRequirement({ ...createdValues, approval: "proposed" })
  const declarations = [duplicateNeed, undecidedStory, proposedCatalog, proposedRequirement]
  const messages = yield* Effect.forEach(declarations, rejection)

  const fragments = [
    "Duplicate declaration id: remember-books",
    "Unresolved decisions in record-reading: May we weaken rejected-attempt preservation?",
    "Declaration reading-list-slice-a@5 is proposed, not an approved obligation",
    "Declaration RL-CREATE@1 is proposed but an approval record approves RL-CREATE@1",
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
    "Input below must pair native-invalid input with a rejected outcome",
    "Input sample must pair native-invalid input with a rejected outcome",
    "Required input missing-input is not declared in create-sample",
  ]

  const found = fragmentsFound(messages, fragments)

  expect(found).toBe(true)
})

const provided = <A, E>(test: Effect.Effect<A, E, FixtureRuntime>) => Effect.provide(test, fixtureLayer)

const authoredCatalog = provided(authoredCatalogTest)
const missingRegistry = provided(missingRegistryTest)
const bindingRejection = provided(bindingRejectionTest)
const readinessRejection = provided(readinessRejectionTest)
const outcomeRejection = provided(outcomeRejectionTest)

it.effect("the authored catalog resolves its platform import, refinement, and bindings against the compiled application", Function.constant(authoredCatalog))
it.effect("the platform import is rejected as missing when the registry does not supply it", Function.constant(missingRegistry))
it.effect("imported declarations reject missing operations, resources, fixtures, text, facts, evaluators, actors, and unscoped requirements", Function.constant(bindingRejection))
it.effect("duplicate identities, proposals, and unresolved decisions prevent a contract-ready declaration", Function.constant(readinessRejection))
it.effect("contradictory validity and outcome declarations and undeclared required inputs remain rejected", Function.constant(outcomeRejection))
