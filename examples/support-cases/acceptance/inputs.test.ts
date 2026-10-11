import { expect, it } from "@effect/vitest"
import { Array, Context, Effect, Equal, Function, Option, Record, Schema, Struct, pipe } from "effect"
import { inputLayer } from "@effect-domains/acceptance/inputs"
import { type AcceptanceError, Candidate, Catalog, InputCandidates, type InputCase, PreparedFixture, Scenario, Submission, type Payload } from "@effect-domains/acceptance/model"
import { SupportCasesApplication } from "../application.ts"
import { AgentOffDuty, SupportCasePrioritySchema } from "../domain.ts"
import { supportCasesCatalog } from "./catalog.ts"

const seed = 20261010

const isPriority = Schema.is(SupportCasePrioritySchema)

const baselineFacts: Payload = {
  "customer.id": "acme",
  "agent.on-duty.id": "riley",
  "agent.off-duty.id": "sam",
}

const freshFacts: Payload = {
  "customer.id": "globex",
  "agent.on-duty.id": "morgan",
  "agent.off-duty.id": "quinn",
}

const targetFacts: Payload = {
  "customer.id": "acme",
  "agent.on-duty.id": "riley",
  "agent.off-duty.id": "sam",
  "target.id": "case-target",
  "target.version": 3,
}

const missingCustomerFacts: Payload = {
  "agent.on-duty.id": "riley",
  "agent.off-duty.id": "sam",
}

const fixtureWith = (facts: Payload) => PreparedFixture.make({
  binding: "support-baseline",
  url: "http://127.0.0.1/",
  actor: "operator",
  facts,
  tracked: [],
})

const baselineFixture = fixtureWith(baselineFacts)

const freshFixture = fixtureWith(freshFacts)

const targetFixture = fixtureWith(targetFacts)

const missingCustomerFixture = fixtureWith(missingCustomerFacts)

const absentValue: Option.Option<unknown> = Option.none()

const accepted = (inputCase: string, operation: string, result: Payload, at: string) => Submission.make({
  inputCase,
  operation,
  input: {},
  status: 200,
  result: Option.some(result),
  error: absentValue,
  at,
})

const caseRow = (id: string, customerId: string, status: string, version: number): Payload => ({
  id,
  customerId,
  subject: "Cannot export quarterly report",
  priority: "high",
  status,
  assignedAgentId: null,
  openedAt: "2026-10-10T12:00:00.000Z",
  version,
})

const deniedResult: Option.Option<unknown> = Option.some({ id: "case-1", version: 99 })

const offDuty = AgentOffDuty.make({ agentId: "sam" })

const deniedAssign = Submission.make({
  inputCase: "assign",
  operation: "support.advanceCase",
  input: {},
  status: 422,
  result: deniedResult,
  error: Option.some(offDuty),
  at: "2026-10-10T12:00:03.000Z",
})

const openedRow = caseRow("case-1", "acme", "open", 1)

const triagedRow = caseRow("case-1", "acme", "triaged", 2)

const freshOpenedRow = caseRow("case-9", "globex", "open", 1)

const opened = accepted("open", "support.openCase", openedRow, "2026-10-10T12:00:01.000Z")

const triaged = accepted("triage", "support.advanceCase", triagedRow, "2026-10-10T12:00:02.000Z")

const freshOpened = accepted("open", "support.openCase", freshOpenedRow, "2026-10-10T13:00:01.000Z")

const decodedCatalog = Schema.decodeUnknownEffect(Catalog)(supportCasesCatalog)

const withId = (id: string) => (declaration: Scenario | Candidate | InputCase) => {
  const identity = Schema.is(Candidate)(declaration) ? declaration.inputCase : declaration.id

  return Equal.equals(identity, id)
}

const scenarioNamed = Effect.fn("inputs.test.scenarioNamed")(function* (id: string) {
  const catalog = yield* decodedCatalog

  return yield* pipe(catalog.scenarios, Array.findFirst(withId(id)), Effect.fromOption)
})

const candidateNamed = (candidates: ReadonlyArray<Candidate>, id: string) => pipe(candidates, Array.findFirst(withId(id)), Effect.fromOption)

const failureBoundary = <A, R>(effect: Effect.Effect<A, AcceptanceError, R>) => pipe(effect, Effect.flip, Effect.map(Struct.get("boundary")))

const lifecycleTest = Effect.gen(function* () {
  const inputs = yield* InputCandidates
  const lifecycle = yield* scenarioNamed("case-lifecycle")
  const before = yield* inputs.resolve(lifecycle, baselineFixture, [], seed)
  const beforeIds = Array.map(before, Struct.get("inputCase"))
  const open = yield* candidateNamed(before, "open")
  const priority = isPriority(open.input.priority)

  expect(beforeIds).toEqual(["open"])
  expect(open.input.customerId).toBe("acme")
  expect(open.input.subject).toBe("Cannot export quarterly report")
  expect(priority).toBe(true)
  expect(open.validity).toBe("native-valid")
  expect(open.seed).toBe(seed)
  expect(open.nativeValidation).toMatch(/^accepted by the exact native support\.openCase codec/)

  const after = yield* inputs.resolve(lifecycle, baselineFixture, [opened], seed)
  const afterIds = Array.map(after, Struct.get("inputCase"))
  const triage = yield* candidateNamed(after, "triage")
  const assign = yield* candidateNamed(after, "assign")
  const reopen = yield* candidateNamed(after, "reopen")

  expect(afterIds).toEqual(["open", "triage", "assign", "resolve", "reopen"])
  expect(triage.input).toEqual({ caseId: "case-1", expectedVersion: 1, action: "triage", note: "Reproduced from the export payload." })
  expect(assign.input).toEqual({ caseId: "case-1", expectedVersion: 1, action: "assign", assignedAgentId: "riley" })
  expect(reopen.input.note).toBe("The customer reports the quarterly export failing again.")
  expect(triage.validity).toBe("native-valid")
  expect(triage.seed).toBe(seed + 1)

  const later = yield* inputs.resolve(lifecycle, baselineFixture, [opened, triaged, deniedAssign], seed)
  const laterAssign = yield* candidateNamed(later, "assign")

  expect(laterAssign.input.expectedVersion).toBe(2)
})

const policyCasesTest = Effect.gen(function* () {
  const inputs = yield* InputCandidates
  const stale = yield* scenarioNamed("stale-version-denied")
  const invalid = yield* scenarioNamed("invalid-version-rejected")
  const staleCandidates = yield* inputs.resolve(stale, targetFixture, [], seed)
  const invalidCandidates = yield* inputs.resolve(invalid, targetFixture, [], seed)
  const staleAssign = yield* candidateNamed(staleCandidates, "stale-assign")
  const zero = yield* candidateNamed(invalidCandidates, "zero-version-triage")

  expect(staleAssign.input).toEqual({ caseId: "case-target", expectedVersion: 2, action: "assign", assignedAgentId: "riley" })
  expect(staleAssign.validity).toBe("native-valid")
  expect(zero.input).toEqual({ caseId: "case-target", expectedVersion: 0, action: "triage" })
  expect(zero.validity).toBe("native-invalid")
  expect(zero.nativeValidation).toMatch(/^rejected by the exact native support\.advanceCase codec: /)
})

const nativeSampleTest = Effect.gen(function* () {
  const inputs = yield* InputCandidates
  const lifecycle = yield* scenarioNamed("case-lifecycle")
  const seeds = Array.makeBy(16, (index) => seed + index * 7)
  const resolveAt = (at: number) => inputs.resolve(lifecycle, baselineFixture, [], at)
  const first = yield* Effect.forEach(seeds, resolveAt)
  const second = yield* Effect.forEach(seeds, resolveAt)
  const candidates = Array.flatten(first)
  const priorities = Array.map(candidates, Struct.get("input"))
  const validities = Array.map(candidates, Struct.get("validity"))
  const allPriorities = Array.every(priorities, Function.flow(Struct.get("priority"), isPriority))
  const allValid = Array.replicate("native-valid", 16)

  expect(second).toEqual(first)
  expect(allPriorities).toBe(true)
  expect(validities).toEqual(allValid)
})

const missingSourcesTest = Effect.gen(function* () {
  const inputs = yield* InputCandidates
  const lifecycle = yield* scenarioNamed("case-lifecycle")
  const missingFact = inputs.resolve(lifecycle, missingCustomerFixture, [], seed)
  const fractionalSeed = inputs.resolve(lifecycle, baselineFixture, [], 1.5)
  const boundaries = yield* Effect.forEach([missingFact, fractionalSeed], failureBoundary)

  expect(boundaries).toEqual(["inputs.fixture", "inputs.unsupported"])
})

const nativeValid: InputCase["validity"] = "native-valid"

const toCandidate = (fields: Parameters<typeof Candidate.make>[0]) => Candidate.make(fields)

const declaredValid = Struct.evolve({ validity: Function.constant(nativeValid) })

const encodedWithId = (id: string) => (declaration: typeof Scenario.Encoded) => Equal.equals(declaration.id, id)

const validityDefectTest = Effect.gen(function* () {
  const inputs = yield* InputCandidates
  const invalid = yield* pipe(supportCasesCatalog.scenarios, Array.findFirst(encodedWithId("invalid-version-rejected")), Effect.fromOption)
  const mislabeledDeclaration = Struct.evolve(invalid, { inputs: Array.map(declaredValid) })
  const mislabeled = yield* Schema.decodeUnknownEffect(Scenario)(mislabeledDeclaration)
  const resolution = inputs.resolve(mislabeled, targetFixture, [], seed)
  const boundary = yield* failureBoundary(resolution)

  expect(mislabeled.inputs).toHaveLength(1)
  expect(boundary).toBe("inputs.validity")
})

const withInput = (input: Payload) => (candidate: Candidate) => pipe(candidate, Struct.evolve({ input: Function.constant(input) }), toCandidate)

const replayTest = Effect.gen(function* () {
  const inputs = yield* InputCandidates
  const lifecycle = yield* scenarioNamed("case-lifecycle")
  const recorded = yield* inputs.resolve(lifecycle, baselineFixture, [opened], seed)
  const recordedOpen = yield* candidateNamed(recorded, "open")
  const replayed = yield* inputs.replay(lifecycle, recorded, freshFixture, [freshOpened])
  const replayedOpen = yield* candidateNamed(replayed, "open")
  const replayedAssign = yield* candidateNamed(replayed, "assign")
  const replayedTriage = yield* candidateNamed(replayed, "triage")
  const replayedIds = Array.map(replayed, Struct.get("inputCase"))

  expect(replayedIds).toEqual(["open", "triage", "assign", "resolve", "reopen"])
  expect(replayedOpen.input.customerId).toBe("globex")
  expect(replayedOpen.input.priority).toBe(recordedOpen.input.priority)
  expect(replayedOpen.input.subject).toBe(recordedOpen.input.subject)
  expect(replayedOpen.seed).toBe(recordedOpen.seed)
  expect(replayedAssign.input).toEqual({ caseId: "case-9", expectedVersion: 1, action: "assign", assignedAgentId: "morgan" })
  expect(replayedTriage.input.note).toBe("Reproduced from the export payload.")
  expect(replayedOpen.nativeValidation).toContain("during concrete-input replay")

  const unresolved = yield* inputs.replay(lifecycle, recorded, freshFixture, [])
  const unresolvedIds = Array.map(unresolved, Struct.get("inputCase"))

  expect(unresolvedIds).toEqual(["open"])

  const recordedTriage = yield* candidateNamed(recorded, "triage")
  const tamperedInput = Record.set(recordedTriage.input, "action", "resolve")
  const tampered = withInput(tamperedInput)(recordedTriage)
  const stale = yield* scenarioNamed("stale-version-denied")
  const tamperedReplay = inputs.replay(lifecycle, [tampered], freshFixture, [freshOpened])
  const undeclaredReplay = inputs.replay(stale, [recordedTriage], targetFixture, [])
  const boundaries = yield* Effect.forEach([tamperedReplay, undeclaredReplay], failureBoundary)

  expect(boundaries).toEqual(["inputs.replay", "inputs.replay"])
})

const codecServices = Context.empty()

const layer = inputLayer(SupportCasesApplication, codecServices)

const provided = Effect.provide(layer)

const lifecycle = provided(lifecycleTest)

const policyCases = provided(policyCasesTest)

const nativeSample = provided(nativeSampleTest)

const missingSources = provided(missingSourcesTest)

const validityDefect = provided(validityDefectTest)

const replay = provided(replayTest)

it.effect("lifecycle inputs resolve only after the case they advance has been captured from an accepted submission", Function.constant(lifecycle))

it.effect("stale and zero versions come from fixture offsets and literals, with the native-invalid payload kept raw", Function.constant(policyCases))

it.effect("native priority samples are seed-stable and native-valid", Function.constant(nativeSample))

it.effect("missing fixture facts and fractional seeds fail explicitly", Function.constant(missingSources))

it.effect("a declared validity the native codec contradicts is a generator defect", Function.constant(validityDefect))

it.effect("replay rebinds fixture and captured fields, keeps recorded concrete values, and rejects tampered or undeclared records", Function.constant(replay))
