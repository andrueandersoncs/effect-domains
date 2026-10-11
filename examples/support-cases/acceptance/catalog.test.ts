import { expect, it } from "@effect/vitest"
import { Array, Effect, Equal, Function, Schema, String as Text, Struct, pipe } from "effect"
import { CatalogBindings, validateCatalog } from "@effect-domains/acceptance/catalog"
import { Catalog, FixtureRuntime } from "@effect-domains/acceptance/model"
import { SupportCasesApplication } from "../application.ts"
import { supportCasesCatalog } from "./catalog.ts"
import { evaluatorNames } from "./evaluation.ts"
import { definition } from "./definition.ts"
import { fixtureLayer } from "./fixture.ts"

const DeclarationSchema = Schema.toEncoded(Catalog)

type Declaration = typeof DeclarationSchema.Type

const bindings = Effect.gen(function* () {
  const runtime = yield* FixtureRuntime

  return CatalogBindings.make({ evaluators: evaluatorNames, fixtures: runtime.bindings, actors: runtime.actors, facts: runtime.facts, probes: runtime.probes })
})

const replacing = <Key extends "actors" | "scenarios">(key: Key) => (entry: Declaration[Key][number]) => DeclarationSchema.make({ ...supportCasesCatalog, [key]: [entry] })
const withScenario = replacing("scenarios")
const withActor = replacing("actors")
const containsFragment = ([message, fragment]: readonly [string, string]) => Text.includes(fragment)(message)

const fragmentsFound = (messages: ReadonlyArray<string>, fragments: ReadonlyArray<string>) => {
  const pairs = Array.zip(messages, fragments)
  const found = Array.map(pairs, containsFragment)
  const expectedCount = Array.length(fragments)
  const observedCount = Array.length(messages)
  const sameLength = Equal.equals(expectedCount, observedCount)

  return sameLength && Array.every(found, Boolean)
}

const rejectionOf = (bound: CatalogBindings) => Effect.fn("SupportCatalogTest.rejection")(function* (declaration: Declaration) {
  const failure = yield* pipe(validateCatalog(declaration, bound, SupportCasesApplication, definition.observationOperation), Effect.flip)

  return failure.message
})

const authoredCatalogTest = Effect.gen(function* () {
  const bound = yield* bindings
  const catalog = yield* validateCatalog(supportCasesCatalog, bound, SupportCasesApplication, definition.observationOperation)
  const scenarioIds = Array.map(catalog.scenarios, Struct.get("id"))
  const requirementIds = Array.map(catalog.requirements, Struct.get("id"))

  expect(scenarioIds).toEqual(["case-lifecycle", "stale-version-denied", "off-duty-denied", "missing-assignment-denied", "disallowed-transition-denied", "invalid-version-rejected", "audit-admin", "audit-reader-denied", "audit-visitor-denied"])
  expect(requirementIds).toEqual(["SC-OPEN", "SC-LIFECYCLE", "SC-HISTORY", "SC-JOIN", "SC-AUDIT", "SC-PRESERVE", "SC-DENY", "SC-REJECT", "SC-AUDIT-READ", "SC-AUDIT-DENY"])
})

const nativeBindingRejectionTest = Effect.gen(function* () {
  const bound = yield* bindings
  const rejection = rejectionOf(bound)
  const lifecycleScenario = yield* pipe(supportCasesCatalog.scenarios, Array.get(0), Effect.fromOption)
  const staleScenario = yield* pipe(supportCasesCatalog.scenarios, Array.get(1), Effect.fromOption)
  const staleInput = yield* pipe(staleScenario.inputs, Array.head, Effect.fromOption)
  const undeclaredFailure = withScenario({ ...staleScenario, inputs: [{ ...staleInput, outcome: { kind: "denied", failure: "MadeUpFailure" } }] })
  const unknownField = withScenario({ ...staleScenario, inputs: [{ ...staleInput, fields: { ...staleInput.fields, priority: { source: "literal", value: "high" } } }] })
  const unknownFact = withScenario({ ...staleScenario, inputs: [{ ...staleInput, fields: { ...staleInput.fields, caseId: { source: "fixture", fact: "obsolete.case", offset: 0 } } }] })
  const incoherentValidity = withScenario({ ...staleScenario, inputs: [{ ...staleInput, validity: "native-invalid" }] })
  const unboundedOperation = withScenario({ ...lifecycleScenario, operations: ["support.openCase"] })
  const unboundFixture = withScenario({ ...staleScenario, fixture: "shared-production-data" })
  const unscopedRequirement = withScenario({ ...staleScenario, requirements: ["SC-AUDIT-READ"] })
  const unknownObservation = withScenario({ ...staleScenario, observations: ["support_case_audits"] })
  const unboundProbe = withScenario({ ...staleScenario, probes: ["ledger-export"] })
  const messages = yield* Effect.forEach([undeclaredFailure, unknownField, unknownFact, incoherentValidity, unboundedOperation, unboundFixture, unscopedRequirement, unknownObservation, unboundProbe], rejection)

  const fragments = [
    "expects a failure the native support.advanceCase contract does not declare",
    "field priority is not in the native support.advanceCase payload",
    "uses unknown fixture fact obsolete.case",
    "must pair native-invalid input with a rejected outcome",
    "outside the scenario's operations",
    "names missing fixture binding shared-production-data",
    "references requirement SC-AUDIT-READ outside story protect-lifecycle-integrity",
    "whose mapped operation support_case_audits.list is not a native list operation",
    "uses probe ledger-export, which the fixture runtime does not implement",
  ]

  const found = fragmentsFound(messages, fragments)

  expect(messages).toHaveLength(9)
  expect(found).toBe(true)
})

const unboundActorTest = Effect.gen(function* () {
  const bound = yield* bindings
  const adminActor = yield* pipe(supportCasesCatalog.actors, Array.get(1), Effect.fromOption)
  const unboundActor = withActor({ ...adminActor, binding: "root-shell" })
  const message = yield* rejectionOf(bound)(unboundActor)

  expect(message).toContain("Actor administrator names missing actor binding root-shell")
})

const provided = <A, E>(test: Effect.Effect<A, E, FixtureRuntime>) => Effect.provide(test, fixtureLayer)

const authoredCatalog = provided(authoredCatalogTest)
const nativeBindingRejection = provided(nativeBindingRejectionTest)
const unboundActor = provided(unboundActorTest)

it.effect("the authored Support Cases catalog validates against the compiled application and fixture bindings", Function.constant(authoredCatalog))
it.effect("native failure tags, payload fields, fixture facts, bounded operations, observations, and probes are enforced", Function.constant(nativeBindingRejection))
it.effect("unbound actors are rejected", Function.constant(unboundActor))
