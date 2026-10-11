import { expect, it } from "@effect/vitest"
import { Array, Effect, Equal, Function, Option, Order, Predicate, Record, Schema, Struct, flow, pipe } from "effect"
import { evaluationLayer, evaluatorRevisions, verifyDefects, VerifierReport } from "./evaluation.ts"
import { BoundRequirement, EvaluationContext, RequirementEvaluation, type RequirementResult, Submission } from "@effect-domains/acceptance/model"

type VerifiedCase = VerifierReport["cases"][number]

const ofKind = (kind: VerifiedCase["kind"]) => (control: VerifiedCase) => Equal.equals(control.kind, kind)
const byCaseId = (id: string) => (control: VerifiedCase) => Equal.equals(control.id, id)
const sum = (total: number, value: number) => total + value
const failingCount = (control: VerifiedCase) => Array.length(control.expectedFailingCriteria)
const isPositive = (value: number) => value > 0
const verdictEntry = (result: RequirementResult) => [result.evaluator, result.status] as const

const expectedFailingStatuses = (control: VerifiedCase) => {
  const named = (result: RequirementResult) => Array.contains(control.expectedFailingCriteria, result.evaluator)
  const failing = Array.filter(control.results, named)

  return Array.map(failing, Struct.get("status"))
}

const verdicts = (control: VerifiedCase) => pipe(control.results, Array.map(verdictEntry), Record.fromEntries)
const verifiedCase = (report: VerifierReport, id: string) => pipe(report.cases, Array.findFirst(byCaseId(id)), Effect.fromOption)
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
  const cleanResults = Array.flatMap(cleanControls, Struct.get("results"))
  const cleanStatuses = Array.map(cleanResults, Struct.get("status"))
  const cleanCount = Array.length(cleanStatuses)
  const expectedPasses = Array.replicate("pass", cleanCount)
  const cleanEvaluators = pipe(cleanResults, Array.map(Struct.get("evaluator")), Array.dedupe, Array.sort(Order.String))
  const evaluatorNames = pipe(evaluatorRevisions, Record.keys, Array.sort(Order.String))
  const caseCount = Array.length(report.cases)
  const encoded = yield* encodeReport(report)
  const json = JSON.stringify(encoded)
  const decoded = yield* decodeReport(json)

  expect(report.summary.falseAcceptance).toBe(0)
  expect(report.summary.falseRejection).toBe(0)
  expect(report.summary.unexpectedStatuses).toBe(0)
  expect(report.summary.cases).toBe(caseCount)
  expect(report.summary.blocked).toBeGreaterThan(0)
  expect(report.summary.inconclusive).toBeGreaterThan(0)
  expect(report.summary.missingEvidenceControls).toBeGreaterThan(0)
  expect(report.evidenceSource).toBe("deliberately constructed observation controls; not browser or model execution")
  expect(everyDefectFails).toBe(true)
  expect(failingStatuses).toEqual(expectedFailures)
  expect(cleanStatuses).toEqual(expectedPasses)
  expect(cleanEvaluators).toEqual(evaluatorNames)
  expect(decoded.summary).toEqual(report.summary)
})

const explicitVerdictTest = Effect.gen(function* () {
  const report = yield* verifyDefects
  const uncleared = yield* verifiedCase(report, "assignment-not-cleared")
  const wrongJoin = yield* verifiedCase(report, "wrong-join")
  const wrongTag = yield* verifiedCase(report, "wrong-denial-tag")
  const directAllowed = yield* verifiedCase(report, "direct-probe-allowed")
  const missingProbe = yield* verifiedCase(report, "missing-detail-probe")
  const interrupted = yield* verifiedCase(report, "interrupted-before-submission")
  const priorHistory = yield* verifiedCase(report, "pre-existing-subject-event")
  const unclearedVerdicts = verdicts(uncleared)
  const wrongJoinVerdicts = verdicts(wrongJoin)
  const wrongTagVerdicts = verdicts(wrongTag)
  const directVerdicts = verdicts(directAllowed)
  const missingProbeVerdicts = verdicts(missingProbe)
  const priorHistoryVerdicts = verdicts(priorHistory)
  const interruptedStatuses = pipe(interrupted.results, Array.map(Struct.get("status")), Array.dedupe)

  expect(unclearedVerdicts).toEqual({ "opened-case": "pass", "lifecycle-transitions": "fail", "ordered-history": "pass", "history-chronology": "pass", "joined-detail": "pass", "audit-recorded": "pass", "unrelated-unchanged": "pass" })
  expect(wrongJoinVerdicts).toMatchObject({ "joined-detail": "fail", "lifecycle-transitions": "pass" })
  expect(wrongTagVerdicts).toEqual({ "denied-unchanged": "fail", "unrelated-unchanged": "fail" })
  expect(directVerdicts).toEqual({ "audit-denied": "fail", "unrelated-unchanged": "pass" })
  expect(missingProbeVerdicts).toMatchObject({ "joined-detail": "inconclusive", "audit-recorded": "pass" })
  expect(priorHistoryVerdicts).toMatchObject({ "ordered-history": "fail", "joined-detail": "pass" })
  expect(interruptedStatuses).toEqual(["blocked"])
})

const evaluatorRevisionEntry = (result: RequirementResult) => [result.evaluator, result.evaluatorRevision] as const
const isPassing = (status: RequirementResult["status"]) => Equal.equals(status, "pass")
const deviations = flow(verdicts, Record.filter(Predicate.not(isPassing)))

const preparedSubjectTest = Effect.gen(function* () {
  const report = yield* verifyDefects
  const clean = yield* verifiedCase(report, "clean-prepared-desk")
  const historyDeleted = yield* verifiedCase(report, "prepared-prior-history-deleted")
  const auditTruncated = yield* verifiedCase(report, "prepared-prior-audit-truncated")
  const startMismatch = yield* verifiedCase(report, "prepared-start-mismatch")
  const startUnobserved = yield* verifiedCase(report, "prepared-start-unobserved")
  const cleanRevisions = pipe(clean.results, Array.map(evaluatorRevisionEntry), Record.fromEntries)
  const cleanVerdicts = verdicts(clean)
  const historyDeviations = deviations(historyDeleted)
  const auditDeviations = deviations(auditTruncated)
  const mismatchDeviations = deviations(startMismatch)
  const unobservedDeviations = deviations(startUnobserved)
  const controlsWithResults = [historyDeleted, auditTruncated, startMismatch, startUnobserved]
  const evaluatedNames = Array.map(controlsWithResults, flow(verdicts, Record.keys))
  const cleanNames = Record.keys(cleanVerdicts)
  const expectedNames = Array.replicate(cleanNames, 4)

  expect(clean.observations.scenario.id).toBe("desk-triage-assign")
  expect(cleanVerdicts).toEqual({ "lifecycle-transitions": "pass", "ordered-history": "pass", "history-chronology": "pass", "joined-detail": "pass", "audit-recorded": "pass", "unrelated-unchanged": "pass" })
  expect(cleanRevisions).toEqual({ "lifecycle-transitions": "2", "ordered-history": "2", "history-chronology": "1", "joined-detail": "2", "audit-recorded": "2", "unrelated-unchanged": "1" })
  expect(evaluatedNames).toEqual(expectedNames)
  expect(historyDeviations).toEqual({ "ordered-history": "fail", "unrelated-unchanged": "fail" })
  expect(auditDeviations).toEqual({ "audit-recorded": "fail" })
  expect(mismatchDeviations).toEqual({ "lifecycle-transitions": "fail" })
  expect(unobservedDeviations).toEqual({ "lifecycle-transitions": "inconclusive" })
})

const byEvaluator = (evaluator: string) => (result: RequirementResult) => Equal.equals(result.evaluator, evaluator)
const raceSettled = { "history-chronology": "pass", "unrelated-unchanged": "pass" }

const verdictsFor = (report: VerifierReport) => Effect.fn("SupportEvaluationTest.verdicts")(function* (id: string) {
  const control = yield* verifiedCase(report, id)

  return verdicts(control)
})

const deviationsFor = (report: VerifierReport) => Effect.fn("SupportEvaluationTest.deviations")(function* (id: string) {
  const control = yield* verifiedCase(report, id)

  return deviations(control)
})

const raceVerdictTest = Effect.gen(function* () {
  const report = yield* verifyDefects
  const verdictsOf = verdictsFor(report)
  const singleWinner = yield* verifiedCase(report, "clean-race-single-winner")
  const singleWinnerVerdicts = verdicts(singleWinner)
  const twoAccepted = yield* verdictsOf("race-two-accepted")
  const bothDenied = yield* verdictsOf("race-both-denied")
  const loserPersisted = yield* verdictsOf("race-loser-agent-persisted")
  const missingLoser = yield* verdictsOf("race-missing-loser-submission")
  const missingExchange = yield* verdictsOf("race-missing-loser-exchange")
  const sequential = yield* verdictsOf("race-sequential-exchanges")
  const unbarriered = yield* verdictsOf("race-missing-barrier")
  const transitionRefusal = yield* verifiedCase(report, "clean-race-transition-refusal")
  const undocumented = yield* verdictsOf("race-undocumented-refusal")
  const transitionWin = yield* pipe(transitionRefusal.results, Array.findFirst(byEvaluator("single-winner")), Effect.fromOption)
  const transitionVerdicts = verdicts(transitionRefusal)
  const winning = yield* pipe(singleWinner.results, Array.findFirst(byEvaluator("single-winner")), Effect.fromOption)

  expect(singleWinner.observations.scenario.id).toBe("race-round-1")
  expect(singleWinnerVerdicts).toEqual({ "single-winner": "pass", ...raceSettled })
  expect(twoAccepted).toEqual({ "single-winner": "fail", ...raceSettled })
  expect(bothDenied).toEqual({ "single-winner": "fail", ...raceSettled })
  expect(loserPersisted).toEqual({ "single-winner": "fail", ...raceSettled })
  expect(missingLoser).toEqual({ "single-winner": "inconclusive", "history-chronology": "inconclusive", "unrelated-unchanged": "inconclusive" })
  expect(missingExchange).toEqual({ "single-winner": "inconclusive", ...raceSettled })
  expect(sequential).toEqual({ "single-winner": "inconclusive", ...raceSettled })
  expect(unbarriered).toEqual({ "single-winner": "inconclusive", ...raceSettled })
  expect(transitionVerdicts).toEqual({ "single-winner": "pass", ...raceSettled })
  expect(transitionWin.explanation).toContain("The loser was refused with InvalidSupportCaseTransition")
  expect(undocumented).toEqual({ "single-winner": "fail", "history-chronology": "fail", "unrelated-unchanged": "fail" })
  expect(winning.explanation).toContain("lane first assign-first (agent agent-grace) sent 2026-10-10T10:01:00.010Z, answered 2026-10-10T10:01:00.060Z: accepted (HTTP 200)")
  expect(winning.explanation).toContain("lane second assign-second (agent agent-erin) sent 2026-10-10T10:01:00.015Z, answered 2026-10-10T10:01:00.070Z: denied VersionConflict (HTTP 422)")
})

const chronologyVerdictTest = Effect.gen(function* () {
  const report = yield* verifyDefects
  const deviationsOf = deviationsFor(report)
  const detailOutOfOrder = yield* deviationsOf("detail-history-out-of-order")
  const reordered = yield* deviationsOf("reordered-history")
  const backdated = yield* deviationsOf("prepared-event-before-prior-history")
  const unwritten = yield* verdictsFor(report)("success-without-write")

  expect(detailOutOfOrder).toEqual({ "history-chronology": "fail" })
  expect(reordered).toEqual({ "ordered-history": "fail", "history-chronology": "fail" })
  expect(backdated).toEqual({ "ordered-history": "fail", "history-chronology": "fail" })
  expect(unwritten).toMatchObject({ "history-chronology": "inconclusive" })
})

const requirement = (evaluator: string) => BoundRequirement.make({
  reference: "test-requirement",
  id: "test-requirement",
  revision: "1",
  text: "This narrative is deliberately not an oracle.",
  evaluator,
  evaluatorRevision: "1",
  category: "behavior",
})

const withServerError = (submission: Submission) => Submission.make({ ...submission, status: 500, error: Option.some("Internal server error") })
const deniedCriterion = requirement("denied-unchanged")
const unknownCriterion = requirement("not-an-evaluator")

const serverErrorTest = Effect.gen(function* () {
  const report = yield* verifyDefects
  const clean = yield* verifiedCase(report, "clean-stale-version-denial")
  const failed = Array.map(clean.observations.submissions, withServerError)
  const context = EvaluationContext.make({ ...clean.observations, submissions: failed })
  const service = yield* RequirementEvaluation
  const result = yield* service.evaluate(deniedCriterion, context)
  const unknownEvaluation = service.evaluate(unknownCriterion, context)
  const unknown = yield* Effect.flip(unknownEvaluation)

  expect(result.status).toBe("inconclusive")
  expect(result.basis).toBe("executable assertion")
  expect(unknown.boundary).toBe("requirement-evaluation")
})

const providedServerErrorTest = Effect.provide(serverErrorTest, evaluationLayer)

it.effect("verifier controls have no false or unexpected verdicts", Function.constant(verifierTest))
it.effect("named defects produce their exact verdicts", Function.constant(explicitVerdictTest))
it.effect("server errors are inconclusive and unknown evaluators fail evaluation", Function.constant(providedServerErrorTest))
it.effect("prepared subject cases keep their prior history and audit and start from their observed state", Function.constant(preparedSubjectTest))
it.effect("a version race passes only with one overlapping winner, fails on two or no winners, and is inconclusive without loser or timing evidence", Function.constant(raceVerdictTest))
it.effect("out-of-order or backdated history fails the chronology contract and an unobserved case leaves it inconclusive", Function.constant(chronologyVerdictTest))
