import { expect, it } from "@effect/vitest"
import { Array, Effect, Equal, Function, Record, Schema, String as Text, Struct, pipe } from "effect"
import { CatalogBindings, validateCatalog } from "@effect-domains/acceptance/catalog"
import { type BoundRequirement, Catalog, FixtureRuntime, type Revision } from "@effect-domains/acceptance/model"
import { platformObligations } from "@effect-domains/acceptance/obligations"
import { SupportCasesApplication } from "../application.ts"
import { supportCasesCatalog } from "./catalog.ts"
import { evaluatorRevisions } from "./evaluation.ts"
import { fixtureLayer } from "./fixture.ts"

const DeclarationSchema = Schema.toEncoded(Catalog)

type Declaration = typeof DeclarationSchema.Type

const bindings = Effect.gen(function* () {
  const runtime = yield* FixtureRuntime

  return CatalogBindings.make({ evaluators: evaluatorRevisions, fixtures: runtime.bindings, actors: runtime.actors, facts: runtime.facts, probes: runtime.probes, catalogs: [platformObligations] })
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
  const failure = yield* pipe(validateCatalog(declaration, bound, SupportCasesApplication), Effect.flip)

  return failure.message
})

const withId = (id: string) => (declaration: Revision) => Equal.equals(declaration.id, id)
const isPreserve = withId("SC-PRESERVE")
const isDesk = withId("desk-triage-assign")
const isReportedProblem = withId("reported-problem")
const isRace = withId("race-round-2")
const isStale = withId("stale-version-denied")
const revisionEntry = (requirement: BoundRequirement) => [requirement.reference, `${requirement.revision}/${requirement.evaluatorRevision}`] as const
const approving = (declaration: string) => (record: Catalog["approvals"][number]) => Array.contains(record.approves, declaration)
const approvesDesk = approving("desk-triage-assign@1")
const approvesRace = approving("SC-RACE@1")
const approvesRaceRevision = approving("SC-RACE@2")
const approvesRubric = approving("refusal-feedback-clarity@1")

const authoredCatalogTest = Effect.gen(function* () {
  const bound = yield* bindings
  const { catalog, requirements, assessments } = yield* validateCatalog(supportCasesCatalog, bound, SupportCasesApplication)
  const scenarioIds = Array.map(catalog.scenarios, Struct.get("id"))
  const references = Array.map(requirements, Struct.get("reference"))
  const features = Array.map(catalog.features, Struct.get("capabilities"))
  const preserve = yield* pipe(catalog.requirements, Array.findFirst(isPreserve), Effect.fromOption)
  const refinement = yield* Effect.fromOption(preserve.refines)
  const desk = yield* pipe(catalog.scenarios, Array.findFirst(isDesk), Effect.fromOption)
  const reportedProblem = yield* pipe(catalog.contexts, Array.findFirst(isReportedProblem), Effect.fromOption)
  const revisions = pipe(requirements, Array.map(revisionEntry), Record.fromEntries)
  const deskApproval = yield* pipe(catalog.approvals, Array.findFirst(approvesDesk), Effect.fromOption)
  const raceApproval = yield* pipe(catalog.approvals, Array.findFirst(approvesRace), Effect.fromOption)
  const raceRevision = yield* pipe(catalog.approvals, Array.findFirst(approvesRaceRevision), Effect.fromOption)
  const race = yield* pipe(catalog.scenarios, Array.findFirst(isRace), Effect.fromOption)
  const raceInput = yield* pipe(race.inputs, Array.head, Effect.fromOption)
  const raceLanes = yield* Effect.fromOption(race.concurrency)
  const laneInputs = Array.map(raceLanes.lanes, Struct.get("inputs"))
  const stale = yield* pipe(catalog.scenarios, Array.findFirst(isStale), Effect.fromOption)
  const assessment = yield* pipe(assessments, Array.head, Effect.fromOption)
  const rubricApproved = Array.some(catalog.approvals, approvesRubric)

  expect(scenarioIds).toEqual(["case-lifecycle", "desk-triage-assign", "stale-version-denied", "off-duty-denied", "missing-assignment-denied", "disallowed-transition-denied", "invalid-version-rejected", "audit-admin", "audit-reader-denied", "audit-visitor-denied", "race-round-1", "race-round-2", "race-round-3"])
  expect(catalog.revision).toBe("6")
  expect(desk.revision).toBe("2")
  expect(desk.fixture).toBe("support-target-open")
  expect(desk.operations).toEqual(["support.advanceCase"])
  expect(desk.required).toEqual(["triage", "assign"])
  expect(desk.requirements).toEqual(["SC-LIFECYCLE", "SC-HISTORY", "SC-CHRONOLOGY", "SC-JOIN", "SC-AUDIT", "SC-PRESERVE"])
  expect(reportedProblem.revision).toBe("3")
  expect(reportedProblem.fixtures).toEqual(["support-baseline", "support-target-open"])
  expect(revisions).toEqual({ "SC-OPEN": "1/1", "SC-LIFECYCLE": "2/2", "SC-HISTORY": "2/2", "SC-CHRONOLOGY": "1/1", "SC-JOIN": "2/2", "SC-AUDIT": "2/2", "SC-PRESERVE": "1/1", "SC-DENY": "1/1", "SC-REJECT": "1/1", "SC-AUDIT-READ": "1/1", "SC-AUDIT-DENY": "1/1", "SC-RACE": "2/2" })
  expect(deskApproval.id).toBe("support-cases-desk-approval")
  expect(deskApproval.approves).toEqual(["support-cases-slice-b@4", "reported-problem@2", "SC-LIFECYCLE@2", "SC-HISTORY@2", "SC-JOIN@2", "SC-AUDIT@2", "desk-triage-assign@1"])
  expect(raceApproval.by).toBe("implementation agent deriving from documented policy (not a user approval)")
  expect(raceApproval.approves).toEqual(["SC-RACE@1", "SC-CHRONOLOGY@1", "competing-operators@1", "settle-competing-assignments@1", "race-round-1@1", "race-round-2@1", "race-round-3@1", "resolve-customer-problem@2", "case-lifecycle@2", "desk-triage-assign@2"])
  expect(raceRevision.id).toBe("support-cases-race-refusal-revision")
  expect(raceRevision.approves).toEqual(["support-cases-slice-b@6", "SC-RACE@2", "settle-competing-assignments@2", "race-round-1@2", "race-round-2@2", "race-round-3@2"])
  expect(raceRevision.basis).toContain("An invalid edge fails with `InvalidSupportCaseTransition`")
  expect(raceInput.outcome).toEqual({ kind: "contended", failures: ["VersionConflict", "InvalidSupportCaseTransition"] })
  expect(race.revision).toBe("2")
  expect(race.requirements).toEqual(["SC-RACE", "SC-CHRONOLOGY", "SC-PRESERVE"])
  expect(raceLanes.barrier).toBe("submit")
  expect(laneInputs).toEqual([["assign-first"], ["assign-second"]])
  expect(stale.revision).toBe("3")
  expect(stale.assessments).toEqual(["SC-REFUSAL-FEEDBACK"])
  expect(stale.requirements).toEqual(["SC-DENY", "SC-PRESERVE"])
  expect(assessment.reference).toBe("SC-REFUSAL-FEEDBACK")
  expect(assessment.requirement.approval).toBe("proposed")
  expect(assessment.rubric.approval).toBe("proposed")
  expect(assessment.rubric.threshold).toBe("clear")
  expect(rubricApproved).toBe(false)
  expect(references).toEqual(["SC-OPEN", "SC-LIFECYCLE", "SC-HISTORY", "SC-CHRONOLOGY", "SC-JOIN", "SC-AUDIT", "SC-PRESERVE", "SC-DENY", "SC-REJECT", "SC-AUDIT-READ", "SC-AUDIT-DENY", "SC-RACE"])
  expect(features).toEqual([["open-case", "advance-case"], ["audit-lifecycle"]])
  expect(refinement.requirement).toBe("platform:PLATFORM-PRESERVE")
  expect(refinement.arguments).toEqual({ scope: "unrelated cases, their history and audit records, customers, and agents" })
})

const nativeBindingRejectionTest = Effect.gen(function* () {
  const bound = yield* bindings
  const rejection = rejectionOf(bound)
  const lifecycleScenario = yield* pipe(supportCasesCatalog.scenarios, Array.get(0), Effect.fromOption)
  const staleScenario = yield* pipe(supportCasesCatalog.scenarios, Array.get(2), Effect.fromOption)
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
    "Field priority is not in the native support.advanceCase payload",
    "Unknown fixture fact obsolete.case",
    "must pair native-invalid input with a rejected outcome",
    "outside the scenario's bounded operations",
    "Missing fixture binding shared-production-data",
    "Requirement SC-AUDIT-READ is not scoped",
    "Observation support_case_audits in stale-version-denied has no native list operation",
    "Probe ledger-export in stale-version-denied is not implemented by the fixture runtime",
  ]

  const found = fragmentsFound(messages, fragments)

  expect(messages).toHaveLength(9)
  expect(found).toBe(true)
})

const readinessRejectionTest = Effect.gen(function* () {
  const bound = yield* bindings
  const rejection = rejectionOf(bound)
  const adminActor = yield* pipe(supportCasesCatalog.actors, Array.get(1), Effect.fromOption)
  const proposed = DeclarationSchema.make({ ...supportCasesCatalog, approval: "proposed" })
  const unboundActor = withActor({ ...adminActor, binding: "root-shell" })
  const messages = yield* Effect.forEach([proposed, unboundActor], rejection)
  const found = fragmentsFound(messages, ["is proposed, not an approved obligation", "Missing actor binding root-shell"])

  expect(found).toBe(true)
})

const provided = <A, E>(test: Effect.Effect<A, E, FixtureRuntime>) => Effect.provide(test, fixtureLayer)

const authoredCatalog = provided(authoredCatalogTest)
const nativeBindingRejection = provided(nativeBindingRejectionTest)
const readinessRejection = provided(readinessRejectionTest)

it.effect("the authored Support Cases catalog resolves its platform import, refinement, features, and bindings against the compiled application", Function.constant(authoredCatalog))
it.effect("native failure tags, payload fields, fixture facts, bounded operations, observations, and probes are enforced", Function.constant(nativeBindingRejection))
it.effect("proposed declarations and unbound actors are not contract-ready", Function.constant(readinessRejection))
