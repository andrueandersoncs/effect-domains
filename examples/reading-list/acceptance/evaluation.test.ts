import { expect, it } from "@effect/vitest"
import { Array, Effect, Equal, Function, Option, Record, Schema, String, Struct, flow, pipe } from "effect"
import { BoundRequirement, Candidate, EvaluationContext, InputCase, Observation, PayloadSchema, PreparedFixture, RequirementEvaluation, type RequirementResult, Scenario, Submission, type Payload } from "@effect-domains/acceptance/model"
import { evaluationLayer, evaluatorRevisions, verifyDefects, VerifierReport } from "./evaluation.ts"

type VerifiedCase = VerifierReport["cases"][number]

const sentinel = PayloadSchema.make({ id: "018e0000-0000-7000-8000-000000000001", title: "Keep this book", author: "Fixture", status: "planned", format: "paperback", rating: null, notes: "Keep this note" })
const target = PayloadSchema.make({ id: "018e0000-0000-7000-8000-000000000002", title: "Change this rating", author: "Fixture", status: "reading", format: "ebook", rating: 2, notes: null })
const another = PayloadSchema.make({ ...sentinel, id: "018e0000-0000-7000-8000-000000000003", title: "Another book" })
const input = PayloadSchema.make({ title: "A new book", author: "Actual input", status: "finished", format: "hardcover", rating: 5, notes: null })
const created = PayloadSchema.make({ id: "018e0000-0000-7000-8000-000000000004", ...input })
const evaluatorNames = Record.keys(evaluatorRevisions)
const noValue = Option.none<unknown>()
const createFacts = PayloadSchema.make({ sentinel, "sentinel.id": sentinel.id })
const targetFacts = PayloadSchema.make({ ...createFacts, target, "target.id": target.id })

const requirement = (evaluator: string) => BoundRequirement.make({
  reference: "arbitrary-requirement-id",
  id: "arbitrary-requirement-id",
  revision: "requirement-revision",
  text: "This narrative is deliberately not an oracle.",
  evaluator,
  evaluatorRevision: "evaluator-revision",
  category: "behavior",
})

const testView = (reloaded: boolean) => (rows: Observation["rows"]) => Observation.make({ operation: "books.list", resource: "books", loaded: true, unfiltered: true, complete: true, rows, reloaded, screenshot: Option.none() })
const beforeView = testView(false)
const afterView = testView(true)
const replacingAfter = (context: EvaluationContext) => (after: Observation) => EvaluationContext.make({ ...context, after: [after] })
const withAfterRows = (context: EvaluationContext) => flow(afterView, replacingAfter(context))
const replacingSubmissions = (context: EvaluationContext) => (submissions: ReadonlyArray<Submission>) => EvaluationContext.make({ ...context, submissions })

const subjectCase = (operation: string, accepted: boolean) => InputCase.make({
  id: "subject",
  operation,
  description: "focused evaluation input",
  fields: {},
  validity: accepted ? "native-valid" : "native-invalid",
  outcome: accepted ? { kind: "accepted" } : { kind: "rejected" },
})

const scenarioFor = (inputCase: InputCase) => Scenario.make({
  id: "scenario-id",
  revision: "scenario-revision",
  provenance: "test scenario",
  approval: "approved",
  story: "test-story",
  actor: "reader",
  fixture: "fixture-binding",
  goal: "Exercise one Reading List obligation",
  operations: [inputCase.operation],
  inputs: [inputCase],
  required: [inputCase.id],
  observations: ["books"],
  probes: [],
  requirements: ["arbitrary-requirement-id"],
  assessments: [],
  concurrency: Option.none(),
  watch: Option.none(),
  reload: true,
})

const candidateFor = (inputCase: InputCase, submitted: Payload) => Candidate.make({
  inputCase: inputCase.id,
  operation: inputCase.operation,
  description: inputCase.description,
  input: submitted,
  sources: inputCase.fields,
  validity: inputCase.validity,
  nativeValidation: "explicit test input",
  provenance: "explicit test input",
  seed: 42,
})

const responded = (operation: string, submitted: Payload, status: number, result: Option.Option<unknown>, error: Option.Option<unknown>) => Submission.make({
  inputCase: "subject",
  operation,
  input: submitted,
  status,
  result,
  error,
  at: "2026-10-10T12:00:00.000Z",
  exchange: Option.none(),
  feedback: Option.none(),
})

const succeeded = (operation: string, submitted: Payload, result: unknown) => {
  const value = Option.some(result)

  return responded(operation, submitted, 200, value, noValue)
}

const contextFor = (inputCase: InputCase, facts: Payload, submitted: Payload, submission: Submission, before: Observation, after: Observation) => EvaluationContext.make({
  scenario: scenarioFor(inputCase),
  fixture: PreparedFixture.make({ binding: "fixture-binding", revision: "fixture-revision", url: "about:blank", actor: "public-reader", facts, tracked: [] }),
  candidates: [candidateFor(inputCase, submitted)],
  submissions: [submission],
  before: [before],
  after: [after],
  probes: [],
  directProbe: Option.none(),
  interruption: Option.none(),
  barrier: Option.none(),
  watch: Option.none(),
  evidence: ["before.json", "public-browser-submission.json", "after-reload.json"],
})

const createCase = subjectCase("books.create", true)
const createBefore = beforeView([sentinel, another])
const createAfter = afterView([sentinel, another, created])
const createSubmission = succeeded("books.create", input, created)
const createContext = contextFor(createCase, createFacts, input, createSubmission, createBefore, createAfter)

const rejectedInput = PayloadSchema.make({ ...target, rating: 6 })
const rejectedCase = subjectCase("books.update", false)
const rejectedBefore = beforeView([sentinel, target, another])
const rejectedAfter = afterView([another, target, sentinel])
const rejectionError = Option.some("Invalid input")
const rejectedResponse = responded("books.update", rejectedInput, 400, noValue, rejectionError)
const rejectedContext = contextFor(rejectedCase, targetFacts, rejectedInput, rejectedResponse, rejectedBefore, rejectedAfter)

const statusOf = Effect.fn("EvaluationTest.statusOf")(function* (name: string, context: EvaluationContext) {
  const service = yield* RequirementEvaluation
  const criterion = requirement(name)
  const result = yield* service.evaluate(criterion, context)

  return result.status
})

const statusesOf = (context: EvaluationContext) => (name: string) => statusOf(name, context)
const statusesFor = (name: string) => (context: EvaluationContext) => statusOf(name, context)
const ofKind = (kind: VerifiedCase["kind"]) => (control: VerifiedCase) => Equal.equals(control.kind, kind)
const failingCount = (control: VerifiedCase) => Array.length(control.expectedFailingCriteria)
const sum = (total: number, value: number) => total + value
const isPositive = (value: number) => value > 0
const isCaseReference = String.startsWith("#/cases/")

const expectedFailingStatuses = (control: VerifiedCase) => {
  const named = (result: RequirementResult) => Array.contains(control.expectedFailingCriteria, result.evaluator)
  const failing = Array.filter(control.results, named)

  return Array.map(failing, Struct.get("status"))
}

const evidenceProblems = (control: VerifiedCase) => {
  const scenarioMismatch = (result: RequirementResult) => !Equal.equals(result.scenario, control.observations.scenario.id)
  const evidenceMismatch = (result: RequirementResult) => !Equal.equals(result.evidence, control.observations.evidence)
  const referenceMismatch = (result: RequirementResult) => !Array.every(result.evidence, isCaseReference)
  const scenarios = Array.countBy(control.results, scenarioMismatch)
  const evidence = Array.countBy(control.results, evidenceMismatch)
  const references = Array.countBy(control.results, referenceMismatch)

  return scenarios + evidence + references
}

const constructedLabel = (control: VerifiedCase) => Array.map(control.observations.candidates, Struct.get("provenance"))

const encodeReport = Schema.encodeEffect(VerifierReport)
const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(VerifierReport))

const verifierTest = Effect.gen(function* () {
  const report = yield* verifyDefects
  const defects = Array.filter(report.cases, ofKind("defect"))
  const cleanControls = Array.filter(report.cases, ofKind("clean-control"))
  const failingCriteria = Array.map(defects, failingCount)
  const failingStatuses = Array.flatMap(defects, expectedFailingStatuses)
  const expectedFailingCount = Array.reduce(failingCriteria, 0, sum)
  const expectedFailures = Array.replicate("fail", expectedFailingCount)
  const everyDefectFails = Array.every(failingCriteria, isPositive)
  const cleanStatuses = pipe(cleanControls, Array.flatMap(Struct.get("results")), Array.map(Struct.get("status")))
  const cleanCount = Array.length(cleanStatuses)
  const expectedPasses = Array.replicate("pass", cleanCount)
  const misattributed = pipe(report.cases, Array.map(evidenceProblems), Array.reduce(0, sum))
  const labels = pipe(report.cases, Array.flatMap(constructedLabel), Array.dedupe)
  const reportedCases = Array.length(report.cases)
  const encoded = yield* encodeReport(report)
  const json = JSON.stringify(encoded)
  const decoded = yield* decodeReport(json)
  const decodedCases = Array.length(decoded.cases)

  expect(report.summary.cases).toBe(24)
  expect(report.summary.criteria).toBe(83)
  expect(report.summary.falseAcceptance).toBe(0)
  expect(report.summary.falseRejection).toBe(0)
  expect(report.summary.unexpectedStatuses).toBe(0)
  expect(report.summary.blocked).toBeGreaterThan(0)
  expect(report.summary.inconclusive).toBeGreaterThan(0)
  expect(report.summary.missingEvidenceControls).toBeGreaterThan(0)
  expect(report.evidenceSource).toBe("deliberately constructed observation controls; not browser or model execution")
  expect(labels).toEqual(["deliberately constructed observation control; not browser or model execution"])
  expect(everyDefectFails).toBe(true)
  expect(failingStatuses).toEqual(expectedFailures)
  expect(cleanStatuses).toEqual(expectedPasses)
  expect(misattributed).toBe(0)
  expect(decoded.summary).toEqual(report.summary)
  expect(decodedCases).toBe(reportedCases)
})

const updateCase = subjectCase("books.update", true)

const ratingCheck = Effect.fn("EvaluationTest.ratingCheck")(function* (rating: number | null) {
  const candidate = PayloadSchema.make({ ...target, rating })
  const wrongRating = Equal.equals(rating, 1) ? 5 : 1
  const wrongTarget = PayloadSchema.make({ ...target, rating: wrongRating })
  const wrongOther = PayloadSchema.make({ ...another, rating })
  const submission = succeeded("books.update", candidate, candidate)
  const before = beforeView([sentinel, target, another])
  const after = afterView([another, candidate, sentinel])
  const context = contextFor(updateCase, targetFacts, candidate, submission, before, after)
  const wrong = withAfterRows(context)([sentinel, wrongTarget, wrongOther])
  const accepted = yield* statusOf("accepted-rating", context)
  const rejected = yield* statusOf("accepted-rating", wrong)

  return [accepted, rejected]
})

const ratingTest = Effect.gen(function* () {
  const verdicts = yield* Effect.forEach([1, 5, null], ratingCheck)

  expect(verdicts).toEqual([["pass", "fail"], ["pass", "fail"], ["pass", "fail"]])
})

const creationTest = Effect.gen(function* () {
  const overwrittenRow = PayloadSchema.make({ ...input, id: another.id })
  const duplicateRow = PayloadSchema.make({ ...created })
  const unchanged = withAfterRows(createContext)(createBefore.rows)
  const overwritten = withAfterRows(createContext)([sentinel, overwrittenRow])
  const duplicate = withAfterRows(createContext)([...createAfter.rows, duplicateRow])
  const verdicts = yield* Effect.forEach([unchanged, overwritten, duplicate], statusesFor("created-values"))

  expect(verdicts).toEqual(["fail", "fail", "inconclusive"])
})

const rejectionTest = Effect.gen(function* () {
  const changedRow = PayloadSchema.make({ ...another, notes: "Wrong" })
  const changedOther = withAfterRows(rejectedContext)([sentinel, target, changedRow])
  const deletedOther = withAfterRows(rejectedContext)([sentinel, target])
  const added = withAfterRows(rejectedContext)([...rejectedAfter.rows, created])
  const controls = [changedOther, deletedOther, added]
  const clean = yield* statusOf("rejection-unchanged", rejectedContext)
  const rejections = yield* Effect.forEach(controls, statusesFor("rejection-unchanged"))
  const sentinels = yield* Effect.forEach(controls, statusesFor("sentinel-unchanged"))

  expect(clean).toBe("pass")
  expect(rejections).toEqual(["fail", "fail", "fail"])
  expect(sentinels).toEqual(["pass", "pass", "pass"])
})

const internalErrorTest = Effect.gen(function* () {
  const internalError = Option.some("Internal server error")
  const response = responded("books.update", rejectedInput, 500, noValue, internalError)
  const context = replacingSubmissions(rejectedContext)([response])
  const accepted = succeeded("books.update", rejectedInput, rejectedInput)
  const acceptance = replacingSubmissions(rejectedContext)([accepted])
  const verdict = yield* statusOf("rejection-unchanged", context)
  const acceptedVerdict = yield* statusOf("rejection-unchanged", acceptance)

  expect(verdict).toBe("inconclusive")
  expect(acceptedVerdict).toBe("fail")
})

const allStatuses = (context: EvaluationContext) => Effect.forEach(evaluatorNames, statusesOf(context))

const incompleteViewTest = Effect.gen(function* () {
  const unloaded = Observation.make({ ...createAfter, loaded: false, rows: [] })
  const filtered = Observation.make({ ...createAfter, unfiltered: false })
  const foreign = Observation.make({ ...createAfter, operation: "wrong-resource.list", resource: "wrong-resource" })
  const contexts = Array.map([unloaded, filtered, foreign], replacingAfter(createContext))
  const verdicts = yield* Effect.forEach(contexts, allStatuses)
  const flattened = Array.flatten(verdicts)
  const verdictCount = Array.length(flattened)
  const expected = Array.replicate("inconclusive", 15)

  expect(verdictCount).toBe(15)
  expect(flattened).toEqual(expected)
})

const sentinelIndependenceTest = Effect.gen(function* () {
  const changedSentinel = PayloadSchema.make({ ...sentinel, rating: 1 })
  const changed = withAfterRows(createContext)([changedSentinel, another, created])
  const verdicts = yield* Effect.forEach(["created-values", "accepted-rating", "sentinel-unchanged"], statusesOf(changed))

  expect(verdicts).toEqual(["pass", "pass", "fail"])
})

const creationEvaluators = ["created-values", "reload-visible", "accepted-rating", "sentinel-unchanged"]

const interruptionTest = Effect.gen(function* () {
  const interrupted = EvaluationContext.make({ ...createContext, submissions: [], interruption: Option.some("No available submit action") })
  const missing = replacingSubmissions(createContext)([])
  const lateInterruption = EvaluationContext.make({ ...createContext, interruption: Option.some("Model unavailable after observed submission") })
  const blocked = yield* Effect.forEach(creationEvaluators, statusesOf(interrupted))
  const inconclusive = yield* Effect.forEach(creationEvaluators, statusesOf(missing))
  const passing = yield* Effect.forEach(creationEvaluators, statusesOf(lateInterruption))
  const expectedBlocked = Array.replicate("blocked", 4)
  const expectedInconclusive = Array.replicate("inconclusive", 4)
  const expectedPassing = Array.replicate("pass", 4)

  expect(blocked).toEqual(expectedBlocked)
  expect(inconclusive).toEqual(expectedInconclusive)
  expect(passing).toEqual(expectedPassing)
})

const submissionBindingTest = Effect.gen(function* () {
  const mismatchedInput = PayloadSchema.make({ ...input, title: "Another submitted title" })
  const mismatched = succeeded("books.create", mismatchedInput, created)
  const repeated = replacingSubmissions(createContext)([createSubmission, createSubmission])
  const differing = replacingSubmissions(createContext)([mismatched])
  const repeatedVerdicts = yield* Effect.forEach(creationEvaluators, statusesOf(repeated))
  const differingVerdicts = yield* Effect.forEach(creationEvaluators, statusesOf(differing))
  const expectedRepeated = Array.replicate("inconclusive", 4)
  const expectedDiffering = Array.replicate("fail", 4)

  expect(repeatedVerdicts).toEqual(expectedRepeated)
  expect(differingVerdicts).toEqual(expectedDiffering)
})

const reloadIdentityTest = Effect.gen(function* () {
  const replacementRow = PayloadSchema.make({ ...created, id: "replacement" })
  const replacement = withAfterRows(createContext)([sentinel, another, replacementRow])
  const identityless = succeeded("books.create", input, input)
  const uncaptured = replacingSubmissions(createContext)([identityless])
  const replaced = yield* statusOf("reload-visible", replacement)
  const reloadUncaptured = yield* statusOf("reload-visible", uncaptured)
  const createdUncaptured = yield* statusOf("created-values", uncaptured)

  expect([replaced, reloadUncaptured, createdUncaptured]).toEqual(["fail", "inconclusive", "pass"])
})

const omittedInput = PayloadSchema.make({ title: input.title, author: input.author, status: input.status, format: input.format })
const defaulted = PayloadSchema.make({ ...omittedInput, id: "defaulted-created", rating: null, notes: null })
const omittedSubmission = succeeded("books.create", omittedInput, defaulted)
const omittedAfter = afterView([sentinel, another, defaulted])
const omittedContext = contextFor(createCase, createFacts, omittedInput, omittedSubmission, createBefore, omittedAfter)
const wrongDefault = PayloadSchema.make({ ...defaulted, rating: 1 })
const missingDefaults = PayloadSchema.make({ ...omittedInput, id: defaulted.id })
const wrongDefaultContext = withAfterRows(omittedContext)([sentinel, another, wrongDefault])
const missingDefaultContext = withAfterRows(omittedContext)([sentinel, another, missingDefaults])

const defaultVerdicts = Effect.fn("EvaluationTest.defaultVerdicts")(function* (name: string) {
  const clean = yield* statusOf(name, omittedContext)
  const wrong = yield* statusOf(name, wrongDefaultContext)
  const missing = yield* statusOf(name, missingDefaultContext)

  return [clean, wrong, missing]
})

const defaultsTest = Effect.gen(function* () {
  const invalidInput = PayloadSchema.make({ ...omittedInput, status: "invented-status" })
  const invalidSubmission = succeeded("books.create", invalidInput, defaulted)
  const invalid = contextFor(createCase, createFacts, invalidInput, invalidSubmission, createBefore, omittedAfter)
  const verdicts = yield* Effect.forEach(["created-values", "reload-visible", "accepted-rating"], defaultVerdicts)
  const invalidVerdict = yield* statusOf("created-values", invalid)
  const expected = Array.replicate(["pass", "fail", "fail"], 3)

  expect(verdicts).toEqual(expected)
  expect(invalidVerdict).toBe("blocked")
})

const revisionsTest = Effect.gen(function* () {
  const names = Array.sort(evaluatorNames, String.Order)
  const revisions = Record.values(evaluatorRevisions)
  const firstRevisions = Array.every(revisions, Equal.equals("1"))
  const service = yield* RequirementEvaluation
  const unknownCriterion = requirement("not-an-evaluator")
  const unknown = yield* pipe(service.evaluate(unknownCriterion, createContext), Effect.flip)

  expect(names).toEqual(["accepted-rating", "created-values", "rejection-unchanged", "reload-visible", "sentinel-unchanged"])
  expect(firstRevisions).toBe(true)
  expect(unknown.boundary).toBe("requirement-evaluation")
})

const withEvaluation = Effect.provide(evaluationLayer)
const providedRevisionsTest = withEvaluation(revisionsTest)
const providedRatingTest = withEvaluation(ratingTest)
const providedCreationTest = withEvaluation(creationTest)
const providedRejectionTest = withEvaluation(rejectionTest)
const providedInternalErrorTest = withEvaluation(internalErrorTest)
const providedIncompleteViewTest = withEvaluation(incompleteViewTest)
const providedSentinelIndependenceTest = withEvaluation(sentinelIndependenceTest)
const providedInterruptionTest = withEvaluation(interruptionTest)
const providedSubmissionBindingTest = withEvaluation(submissionBindingTest)
const providedReloadIdentityTest = withEvaluation(reloadIdentityTest)
const providedDefaultsTest = withEvaluation(defaultsTest)

it.effect("clean and deliberately defective evidence is measured by the production evaluators", Function.constant(verifierTest))
it.effect("the five evaluators are published at revision 1 and unknown evaluators fail evaluation", Function.constant(providedRevisionsTest))
it.effect("accepted ratings are checked on the exact update target", Function.constant(providedRatingTest))
it.effect("creation cannot pass by matching display values on an existing identity or trusting a success response", Function.constant(providedCreationTest))
it.effect("rejection compares every field of every identity regardless of ordering", Function.constant(providedRejectionTest))
it.effect("an internal error with unchanged rows is not application rejection evidence and an accepted invalid input fails", Function.constant(providedInternalErrorTest))
it.effect("missing, filtered and unloaded views never pass any criterion", Function.constant(providedIncompleteViewTest))
it.effect("a sentinel failure does not override independent successful creation assertions", Function.constant(providedSentinelIndependenceTest))
it.effect("interruption is blocked only before submission; missing evidence stays inconclusive", Function.constant(providedInterruptionTest))
it.effect("repeated required submissions are inconclusive and a submission other than the candidate fails", Function.constant(providedSubmissionBindingTest))
it.effect("reload binds the created result identity rather than accepting a replacement with identical values", Function.constant(providedReloadIdentityTest))
it.effect("native optional create fields use compiled nullable defaults and wrong defaults fail independently", Function.constant(providedDefaultsTest))
