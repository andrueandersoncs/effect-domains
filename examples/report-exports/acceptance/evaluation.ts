import { Array, Context, Effect, Equal, Function, HashMap, Layer, Number, Option, Order, Record, Schema, SchemaAST, String as Text, Struct, Tuple, flow, pipe } from "effect"
import { createHash } from "node:crypto"
import { basename } from "node:path"
import { AcceptanceError, BoundRequirement, Candidate, Catalog, EvaluationContext, PayloadSchema, PreparedFixture, ProbeRecord, RequirementEvaluation, RequirementResult, ResultStatusSchema, type Scenario, Submission, WatchOutcomeSchema, WatchRecord } from "@effect-domains/acceptance/model"
import { roundTripEvaluators, roundTripLayer, roundTripVerifier } from "@effect-domains/acceptance/roundtrip"
import { ReportExportsApplication } from "../application.ts"
import { reportExportsCatalog } from "./catalog.ts"
import { OutsideArtifactSchema, RetainedArtifactSchema, UndiscoveredSchema } from "./fixture.ts"

type Status = typeof ResultStatusSchema.Type

const completionEvaluator = "eventual-completion"

const completionRevision = "1"

/** The generic round-trip evaluators plus the application-owned eventual-completion evaluator, because one evaluation service judges every requirement. */
export const evaluatorRevisions: Readonly<Record<string, string>> = Record.set(roundTripEvaluators, completionEvaluator, completionRevision)

// No published Report Exports payload codec needs a runtime service because every wire codec is pure.
export const codecServices = Context.empty()

/** One verdict with its reason because the evaluator stops at the first decisive finding. */
class Assertion extends Schema.Class<Assertion>("CompletionAssertion")({
  status: ResultStatusSchema,
  explanation: Schema.String,
}) {}

type Verdict<A> = Effect.Effect<A, Assertion>

const judged = (status: Status) => (explanation: string) => Assertion.make({ status, explanation })

const passed = judged("pass")

const inconclusive = judged("inconclusive")

const settle = Effect.match({ onFailure: Function.identity<Assertion>, onSuccess: Function.identity<Assertion> })

/** Holds when the condition holds and otherwise stops the judgement with the given status and reason. */
const ensure = (condition: boolean, status: Status, explanation: string): Verdict<boolean> => condition ? Effect.succeed(condition) : pipe(explanation, judged(status), Effect.fail)

const presentElse = (status: Status, explanation: string) => <A>(value: Option.Option<A>): Verdict<A> => pipe(value, Effect.fromOption, Effect.mapError(() => judged(status)(explanation)))

const exact: SchemaAST.ParseOptions = { onExcessProperty: "error" }

const PeriodSchema = Schema.Struct({ startsAt: Schema.String, endsAt: Schema.String })

interface Period extends Schema.Schema.Type<typeof PeriodSchema> {}

const DirectionSchema = Schema.Literals(["debit", "credit"])

const LineSchema = Schema.Struct({ accountCode: Schema.String, description: Schema.String, direction: DirectionSchema, amountMinor: Schema.Number })

interface Line extends Schema.Schema.Type<typeof LineSchema> {}

const LinesSchema = Schema.Array(LineSchema)

const SubmittedReportSchema = Schema.Struct({ reportId: Schema.String, reportingPeriod: PeriodSchema, currency: Schema.String, releasePolicy: Schema.String })

interface SubmittedReport extends Schema.Schema.Type<typeof SubmittedReportSchema> {}

const SubmittedRequestSchema = Schema.Struct({ report: SubmittedReportSchema, lines: LinesSchema })

interface SubmittedRequest extends Schema.Schema.Type<typeof SubmittedRequestSchema> {}

const ArtifactReportSchema = Schema.Struct({ reportId: Schema.String, reportingPeriod: PeriodSchema, currency: Schema.String })

interface ArtifactReport extends Schema.Schema.Type<typeof ArtifactReportSchema> {}

const ReleasedBySchema = Schema.NullOr(Schema.String)

const ReleaseSchema = Schema.Struct({ policy: Schema.String, releasedBy: ReleasedBySchema })

interface Release extends Schema.Schema.Type<typeof ReleaseSchema> {}

const TotalsSchema = Schema.Struct({ totalDebitMinor: Schema.Number, totalCreditMinor: Schema.Number })

interface Totals extends Schema.Schema.Type<typeof TotalsSchema> {}

const ArtifactContentSchema = Schema.Struct({ report: ArtifactReportSchema, release: ReleaseSchema, lines: LinesSchema, totals: TotalsSchema })

interface ArtifactContent extends Schema.Schema.Type<typeof ArtifactContentSchema> {}

const ArtifactJsonSchema = Schema.fromJsonString(ArtifactContentSchema)

/** The documented report result fields, which `Generate` returns directly and a Succeeded poll wraps with its tag. */
const ReportResultSchema = Schema.Struct({
  artifactPath: Schema.String,
  reportId: Schema.String,
  reportingPeriod: PeriodSchema,
  currency: Schema.String,
  releasePolicy: Schema.String,
  releasedBy: ReleasedBySchema,
  lineCount: Schema.Number,
  totalDebitMinor: Schema.Number,
  totalCreditMinor: Schema.Number,
})

interface ReportResult extends Schema.Schema.Type<typeof ReportResultSchema> {}

const ArtifactEvidenceSchema = Schema.Union([RetainedArtifactSchema, OutsideArtifactSchema])

const SucceededSchema = Schema.TaggedStruct("Succeeded", { ...ReportResultSchema.fields, executionId: Schema.String, artifact: ArtifactEvidenceSchema })

interface Succeeded extends Schema.Schema.Type<typeof SucceededSchema> {}

const PendingSchema = Schema.TaggedStruct("Pending", { stage: Schema.String, executionId: Schema.String })

const FailedSchema = Schema.TaggedStruct("Failed", { reason: Schema.String, executionId: Schema.String })

const OptionalTextSchema = Schema.OptionFromOptionalKey(Schema.String)

/** Only the status label of a poll because the sequence check must read every observation, whatever its tag. */
const PollTagSchema = Schema.Struct({ _tag: Schema.String, stage: OptionalTextSchema, executionId: OptionalTextSchema })

interface PollTag extends Schema.Schema.Type<typeof PollTagSchema> {}

/** One watched poll reduced to its documented status label and the execution it named. */
class Observed extends Schema.Class<Observed>("CompletionObserved")({
  index: Schema.Int,
  label: Schema.String,
  execution: OptionalTextSchema,
  record: ProbeRecord,
}) {}

const decodeTag = Schema.decodeUnknownOption(PollTagSchema)

const decodeSucceeded = Schema.decodeUnknownOption(SucceededSchema)

const decodeArtifact = Schema.decodeUnknownOption(ArtifactJsonSchema, exact)

const decodeRequest = Schema.decodeUnknownOption(SubmittedRequestSchema, exact)

const decodeReportResult = Schema.decodeUnknownOption(ReportResultSchema, exact)

const undiscoveredLabel = "Undiscovered"

const ambiguousLabel = "Ambiguous"

const succeededLabel = "Succeeded"

/** The documented success order because a status that moves backwards, or leaves this order, is not progress toward completion. */
const progression = [undiscoveredLabel, "Pending accepted", "Pending dispatched", "Pending writing", succeededLabel]

const terminalFailures = ["Failed", "Cancelled"]

const staged = (name: string) => (stage: string) => `${name} ${stage}`

const labelWith = (stage: Option.Option<string>) => (name: string) => Option.match(stage, { onNone: Function.constant(name), onSome: staged(name) })

const unobservedLabel = (record: ProbeRecord) => `Unobserved (HTTP ${record.status})`

const phaseIndex = (record: ProbeRecord) => pipe(record.phase, Text.split(":"), Array.last, Option.flatMap(Number.parse), Option.getOrElse(Function.constant(-1)))

const observedOf = (record: ProbeRecord) => {
  const answered = Equal.equals(record.status, 200)
  const tag = pipe(record.result, Option.filter(Function.constant(answered)), Option.flatMap(decodeTag))
  const stage = Option.flatMap(tag, Struct.get("stage"))
  const name = Option.map(tag, Struct.get("_tag"))
  const unobserved = unobservedLabel(record)
  const label = Option.match(name, { onNone: Function.constant(unobserved), onSome: labelWith(stage) })
  const execution = Option.flatMap(tag, Struct.get("executionId"))
  const index = phaseIndex(record)

  return Observed.make({ index, label, execution, record })
}

const byIndex = Order.mapInput(Order.Number, Struct.get<Observed, "index">("index"))

const watchedBy = (probe: string) => (record: ProbeRecord) => {
  const named = Equal.equals(record.probe, probe)

  return named && Text.startsWith("watch:")(record.phase)
}

const rankOf = (label: string) => Array.findFirstIndex(progression, Equal.equals(label))

const isRanked = (observed: Observed) => pipe(observed.label, rankOf, Option.isSome)

const isUnobserved = (observed: Observed) => Text.startsWith("Unobserved")(observed.label)

const labelled = (label: string) => (observed: Observed) => Equal.equals(observed.label, label)

const terminallyFailed = (observed: Observed) => Array.contains(terminalFailures, observed.label)

const outsideOrder = (observed: Observed) => {
  const ranked = isRanked(observed)
  const unobserved = isUnobserved(observed)
  const known = ranked || unobserved

  return !known
}

const rankedValue = (observed: Observed) => pipe(observed.label, rankOf, Option.getOrElse(Function.constant(0)))

const regressed = ([earlier, later]: readonly [Observed, Observed]) => rankedValue(later) < rankedValue(earlier)

const collapsedLabels = (observed: ReadonlyArray<Observed>) => pipe(observed, Array.map(Struct.get("label")), Array.dedupeAdjacent)

const sequenceText = flow(collapsedLabels, Array.join(" → "))

const lastLabel = (observed: ReadonlyArray<Observed>) => pipe(observed, Array.last, Option.map(Struct.get("label")), Option.getOrElse(Function.constant("none")))

const sha256Of = (text: string) => createHash("sha256").update(text).digest("hex")

const directed = (direction: Line["direction"]) => (line: Line) => Equal.equals(line.direction, direction)

const sumOf = (lines: ReadonlyArray<Line>, direction: Line["direction"]) => pipe(lines, Array.filter(directed(direction)), Array.map(Struct.get("amountMinor")), Number.sumAll)

const expectedTotals = (lines: ReadonlyArray<Line>) => TotalsSchema.make({ totalDebitMinor: sumOf(lines, "debit"), totalCreditMinor: sumOf(lines, "credit") })

const expectedReport = (request: SubmittedRequest) => ArtifactReportSchema.make({ reportId: request.report.reportId, reportingPeriod: request.report.reportingPeriod, currency: request.report.currency })

const automaticRelease = ReleaseSchema.make({ policy: "automatic", releasedBy: null })

const reportResultOf = (succeeded: Succeeded): ReportResult => ReportResultSchema.make({
  artifactPath: succeeded.artifactPath,
  reportId: succeeded.reportId,
  reportingPeriod: succeeded.reportingPeriod,
  currency: succeeded.currency,
  releasePolicy: succeeded.releasePolicy,
  releasedBy: succeeded.releasedBy,
  lineCount: succeeded.lineCount,
  totalDebitMinor: succeeded.totalDebitMinor,
  totalCreditMinor: succeeded.totalCreditMinor,
})

const artifactClaims = (artifactPath: string, artifact: ArtifactContent): ReportResult => ReportResultSchema.make({
  artifactPath,
  reportId: artifact.report.reportId,
  reportingPeriod: artifact.report.reportingPeriod,
  currency: artifact.report.currency,
  releasePolicy: artifact.release.policy,
  releasedBy: artifact.release.releasedBy,
  lineCount: Array.length(artifact.lines),
  totalDebitMinor: artifact.totals.totalDebitMinor,
  totalCreditMinor: artifact.totals.totalCreditMinor,
})

const isRetained = Schema.is(RetainedArtifactSchema)

const isOutside = Schema.is(OutsideArtifactSchema)

type RetainedArtifact = typeof RetainedArtifactSchema.Type

class Retained extends Schema.Class<Retained>("CompletionRetained")({
  succeeded: SucceededSchema,
  content: Schema.String,
  sha256: Schema.String,
}) {}

const retainedFrom = (succeeded: Succeeded) => (artifact: RetainedArtifact) => Retained.make({ succeeded, content: artifact.content, sha256: artifact.sha256 })

const retainedOf = (succeeded: Succeeded) => pipe(succeeded.artifact, Option.liftPredicate(isRetained), Option.map(retainedFrom(succeeded)))

const hashHolds = (retained: Retained) => pipe(retained.content, sha256Of, Equal.equals(retained.sha256))

const sameAs = (first: Retained) => (retained: Retained) => {
  const result = reportResultOf(retained.succeeded)
  const firstResult = reportResultOf(first.succeeded)
  const sameResult = Equal.equals(result, firstResult)
  const sameBytes = Equal.equals(retained.sha256, first.sha256)
  const sameExecution = Equal.equals(retained.succeeded.executionId, first.succeeded.executionId)
  const sameEvidence = sameResult && sameBytes

  return sameEvidence && sameExecution
}

const ofInput = (id: string) => (submission: Submission) => Equal.equals(submission.inputCase, id)

const withinSuccess = Number.between({ minimum: 200, maximum: 299 })

const withInterruption = (prefix: string) => (interruption: string) => `${prefix}: ${interruption}`

const missingWatch = (context: EvaluationContext) => {
  const unrecorded = "no watch was recorded"
  const reason = Option.match(context.interruption, { onNone: Function.constant(unrecorded), onSome: withInterruption(unrecorded) })

  return inconclusive(`Eventual completion was not observed because ${reason}.`)
}

/** Judges the declared watch's discovery, the documented monotone status order, and the deadline; returns the observed sequence. */
const judgeSequence = Effect.fn("ReportExportsAcceptance.judgeSequence")(function* (record: WatchRecord, observed: ReadonlyArray<Observed>) {
  const sequence = sequenceText(observed)
  const nonEmpty = Array.isReadonlyArrayNonEmpty(observed)
  const unambiguous = !Array.some(observed, labelled(ambiguousLabel))
  const unfailed = !Array.some(observed, terminallyFailed)
  const ordered = !Array.some(observed, outsideOrder)
  const ranked = Array.filter(observed, isRanked)
  const later = Array.drop(ranked, 1)
  const pairs = Array.zip(ranked, later)
  const monotone = !Array.some(pairs, regressed)
  const executions = pipe(observed, Array.map(Struct.get("execution")), Array.getSomes, Array.dedupe)
  const executionList = Array.join(executions, ", ")
  const singleExecution = Array.length(executions) <= 1
  const answered = !Array.some(observed, isUnobserved)
  const timely = !Equal.equals(record.outcome, "deadline")
  const last = lastLabel(observed)
  const { deadlineSeconds } = record.watch

  yield* ensure(nonEmpty, "inconclusive", "The declared watch recorded no observation of the export status.")
  yield* ensure(unambiguous, "fail", `Several new executions of the tenant appeared after preparation, so the watched export is ambiguous (sequence: ${sequence}).`)
  yield* ensure(unfailed, "fail", `The export reached the terminal state ${last}, not Succeeded (sequence: ${sequence}).`)
  yield* ensure(monotone, "fail", `The export status moved backwards against the documented order Undiscovered < Pending accepted < Pending dispatched < Pending writing < Succeeded: sequence ${sequence}.`)
  yield* ensure(singleExecution, "fail", `The watched polls named more than one execution (${executionList}).`)
  yield* ensure(answered, "inconclusive", `At least one poll did not answer with a status, so the sequence is incomplete: ${sequence}.`)
  yield* ensure(timely, "inconclusive", `The watch ended at its ${deadlineSeconds}-second deadline after ${record.polls} polls without a terminal state; last observed status: ${last} (sequence: ${sequence}).`)
  yield* ensure(ordered, "fail", `The export status left the documented success order (Recoverable is not success): sequence ${sequence}.`)

  return sequence
})

const succeededOf = flow(Struct.get<Observed, "record">("record"), Struct.get("result"), Option.flatMap(decodeSucceeded))

/** Judges the first Succeeded artifact and its confirmations: retained bytes and hash, immutability, and the documented path name. */
const judgeRetained = Effect.fn("ReportExportsAcceptance.judgeRetained")(function* (observed: ReadonlyArray<Observed>, sequence: string) {
  const decoded = pipe(observed, Array.filter(labelled(succeededLabel)), Array.map(succeededOf))
  const wellFormed = !Array.some(decoded, Option.isNone)
  const succeeded = Array.getSomes(decoded)
  const inside = !pipe(succeeded, Array.map(Struct.get("artifact")), Array.some(isOutside))
  const retained = pipe(succeeded, Array.map(retainedOf), Array.getSomes)

  yield* ensure(wellFormed, "fail", "A Succeeded poll did not carry the documented report result fields and the fixture's artifact evidence.")
  yield* ensure(inside, "fail", "The Succeeded result names an artifact path outside the application's private output directory.")

  const first = yield* pipe(retained, Array.head, presentElse("fail", `The watch ended without a Succeeded observation (sequence: ${sequence}).`))
  const confirmations = Array.drop(retained, 1)
  const confirming = Array.length(confirmations)
  const confirmed = Array.isReadonlyArrayNonEmpty(confirmations)
  const hashesHold = Array.every(retained, hashHolds)
  const immutable = Array.every(confirmations, sameAs(first))
  const { executionId, artifactPath } = first.succeeded
  const fileName = basename(artifactPath)
  const named = Equal.equals(fileName, `${executionId}.json`)

  yield* ensure(confirmed, "inconclusive", `No confirming poll followed the first Succeeded observation, so immutability was not observed (sequence: ${sequence}).`)
  yield* ensure(hashesHold, "fail", "The SHA-256 of the retained artifact bytes does not equal the hash recorded when they were read.")
  yield* ensure(immutable, "fail", "A confirming poll returned a different execution, result, artifact path, or artifact hash than the first Succeeded poll; the artifact is not immutable.")
  yield* ensure(named, "fail", `The artifact path ${artifactPath} is not the documented <output>/${executionId}.json.`)

  return Tuple.make(first, confirming)
})

/** Judges the artifact against the one submitted request and the Succeeded result against the artifact and the generating response. */
const judgeArtifact = Effect.fn("ReportExportsAcceptance.judgeArtifact")(function* (context: EvaluationContext, record: WatchRecord, observed: ReadonlyArray<Observed>, sequence: string) {
  const [first, confirmations] = yield* judgeRetained(observed, sequence)
  const { executionId, artifactPath } = first.succeeded
  const artifact = yield* pipe(first.content, decodeArtifact, presentElse("fail", "The artifact is not exactly the documented JSON with report, release, lines, and totals keys."))
  const { input, deadlineSeconds } = record.watch
  const submissions = Array.filter(context.submissions, ofInput(input))
  const submitted = Array.length(submissions)
  const unsubmitted = missingSubmission(context)
  const submission = yield* pipe(submissions, Array.head, presentElse(unsubmitted.status, unsubmitted.explanation))
  const single = Equal.equals(submitted, 1)

  yield* ensure(single, "inconclusive", `The watched input ${input} was submitted ${submitted} times; exactly one submission is required.`)

  const request = yield* pipe(submission.input, decodeRequest, presentElse("fail", "The submitted request is not a well-formed export request."))
  const report = expectedReport(request)
  const sameReport = Equal.equals(artifact.report, report)
  const sameLines = Equal.equals(artifact.lines, request.lines)
  const totals = expectedTotals(request.lines)
  const { totalDebitMinor, totalCreditMinor } = totals
  const sameTotals = Equal.equals(artifact.totals, totals)
  const released = Equal.equals(artifact.release, automaticRelease)
  const polled = reportResultOf(first.succeeded)
  const claimed = artifactClaims(artifactPath, artifact)
  const agreed = Equal.equals(polled, claimed)

  yield* ensure(sameReport, "fail", "The artifact report differs from the submitted report id, reporting period, or currency.")
  yield* ensure(sameLines, "fail", "The artifact lines differ from the submitted lines.")
  yield* ensure(sameTotals, "fail", `The artifact totals differ from the separate sums of the submitted lines (debit ${totalDebitMinor}, credit ${totalCreditMinor}).`)
  yield* ensure(released, "fail", `The artifact release is not the automatic policy with releasedBy null (the request asked for ${request.report.releasePolicy}).`)
  yield* ensure(agreed, "fail", "The Succeeded result fields disagree with the artifact it names.")

  const accepted = withinSuccess(submission.status)
  const answered = Option.flatMap(submission.result, decodeReportResult)
  const echoed = Option.contains(answered, polled)
  const responseAgrees = accepted ? echoed : true

  yield* ensure(responseAgrees, "fail", "The generating response differs from the Succeeded result without its tag.")

  const response = accepted ? "equals the generating response" : `was not compared with the generating response (HTTP ${submission.status})`

  return passed(`The export of execution ${executionId} completed within the ${deadlineSeconds}-second deadline through the monotone sequence ${sequence}; its immutable artifact (SHA-256 ${first.sha256}, unchanged on ${confirmations} confirming poll(s)) holds exactly the submitted report and lines, separate totals debit ${totalDebitMinor} and credit ${totalCreditMinor}, and an automatic release with no releaser; the Succeeded result agrees with the artifact and ${response}.`)
})

const uncaptured = inconclusive("No submission of the watched input was captured.")

const unsubmittedBecause = (interruption: string) => judged("blocked")(`The watched input was not submitted: ${interruption}`)

const missingSubmission = (context: EvaluationContext) => Option.match(context.interruption, { onNone: Function.constant(uncaptured), onSome: unsubmittedBecause })

const eventualCompletion = Effect.fn("ReportExportsAcceptance.eventualCompletion")(function* (context: EvaluationContext) {
  const unwatched = missingWatch(context)
  const record = yield* pipe(context.watch, presentElse(unwatched.status, unwatched.explanation))
  const observed = pipe(context.probes, Array.filter(watchedBy(record.watch.probe)), Array.map(observedOf), Array.sort(byIndex))
  const sequence = yield* judgeSequence(record, observed)

  return yield* judgeArtifact(context, record, observed, sequence)
}, settle)

const completionResult = (requirement: BoundRequirement, context: EvaluationContext) => (assertion: Assertion) => RequirementResult.make({
  requirement: requirement.reference,
  requirementRevision: requirement.revision,
  scenario: context.scenario.id,
  scenarioRevision: context.scenario.revision,
  evaluator: requirement.evaluator,
  evaluatorRevision: requirement.evaluatorRevision,
  basis: "executable assertion",
  status: assertion.status,
  explanation: assertion.explanation,
  evidence: context.evidence,
})

const staleRevision = (requirement: BoundRequirement) => AcceptanceError.make({ boundary: "evaluation", message: `No ${completionEvaluator} evaluator at revision ${requirement.evaluatorRevision}` })

const evaluateCompletion = Effect.fn("ReportExportsAcceptance.evaluateCompletion")(function* (requirement: BoundRequirement, context: EvaluationContext) {
  const current = Equal.equals(requirement.evaluatorRevision, completionRevision)

  if (!current) return yield* staleRevision(requirement)

  const assertion = yield* eventualCompletion(context)

  return completionResult(requirement, context)(assertion)
})

const isCompletion = (requirement: BoundRequirement) => Equal.equals(requirement.evaluator, completionEvaluator)

const dispatching = Effect.fn("ReportExportsAcceptance.evaluation")(function* () {
  const roundTrip = yield* RequirementEvaluation

  const evaluate = (requirement: BoundRequirement, context: EvaluationContext) => isCompletion(requirement)
    ? evaluateCompletion(requirement, context)
    : roundTrip.evaluate(requirement, context)

  return RequirementEvaluation.of({ evaluate })
})

const roundTrip = roundTripLayer(ReportExportsApplication, codecServices)

const dispatched = dispatching()

/** One evaluation service dispatches by evaluator name because a scenario may bind generic round-trip and application-owned requirements together. */
export const evaluationLayer = pipe(Layer.effect(RequirementEvaluation, dispatched), Layer.provide(roundTrip))

const controlLabel = "deliberately constructed eventual-completion verifier control; not browser, worker, or model execution"
const at = "2026-10-10T00:00:00.000Z"
const controlExecution = "control-execution"
const controlPath = `/control/output/${controlExecution}.json`
const completionScenarioId = "generate-export-completes"
const completionRequirementId = "RE-COMPLETES"

const controlLines: ReadonlyArray<Line> = [
  LineSchema.make({ accountCode: "4000", description: "Control revenue", direction: "credit", amountMinor: 180_000 }),
  LineSchema.make({ accountCode: "6100", description: "Control supplies", direction: "debit", amountMinor: 12_500 }),
]

const controlPeriod = PeriodSchema.make({ startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2027-01-01T00:00:00.000Z" })
const controlReport = SubmittedReportSchema.make({ reportId: "control-completion", reportingPeriod: controlPeriod, currency: "USD", releasePolicy: "automatic" })
const controlRequest = SubmittedRequestSchema.make({ report: controlReport, lines: controlLines })
const controlArtifact = ArtifactContentSchema.make({ report: expectedReport(controlRequest), release: automaticRelease, lines: controlLines, totals: expectedTotals(controlLines) })
const controlJson = JSON.stringify(controlArtifact, null, 2)
const controlContent = `${controlJson}\n`
const controlHash = sha256Of(controlContent)
const alteredContent = Text.replace("180000", "180001")(controlContent)
const controlResult = artifactClaims(controlPath, controlArtifact)

const succeededPoll = (content: string) => {
  const artifact = RetainedArtifactSchema.make({ path: controlPath, content, sha256: controlHash, retained: controlLabel })

  return SucceededSchema.make({ ...controlResult, executionId: controlExecution, artifact })
}

const pendingPoll = (stage: string) => PendingSchema.make({ stage, executionId: controlExecution })
const undiscoveredPoll = UndiscoveredSchema.make({})
const acceptedPoll = pendingPoll("accepted")
const dispatchedPoll = pendingPoll("dispatched")
const writingPoll = pendingPoll("writing")
const failedPoll = FailedSchema.make({ reason: "constructed workflow failure", executionId: controlExecution })
const cleanPoll = succeededPoll(controlContent)
const alteredPoll = succeededPoll(alteredContent)

const PollsSchema = Schema.Array(Schema.Unknown)
const OptionalStateSchema = Schema.OptionFromOptionalKey(Schema.String)

/** A constructed watch with the verdict the evaluator must reach because detection is defined against known defects. */
class Control extends Schema.Class<Control>("CompletionControl")({
  id: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  polls: PollsSchema,
  outcome: WatchOutcomeSchema,
  terminalState: OptionalStateSchema,
  expected: ResultStatusSchema,
}) {}

const succeededState = Option.some(succeededLabel)

/** Exactly the five controls AP-15 names for eventual completion: a clean run, deadline expiry, a Failed terminal state, a regression, and a hash mismatch. */
const controls = [
  Control.make({ id: "clean-completion", description: "The status rises through every documented stage to Succeeded and a confirming poll shows the same artifact", polls: [undiscoveredPoll, acceptedPoll, dispatchedPoll, writingPoll, cleanPoll, cleanPoll], outcome: "terminal", terminalState: succeededState, expected: "pass" }),
  Control.make({ id: "deadline-expired", description: "The watch reaches its deadline while the export is still dispatched", polls: [undiscoveredPoll, acceptedPoll, dispatchedPoll, dispatchedPoll], outcome: "deadline", terminalState: Option.none(), expected: "inconclusive" }),
  Control.make({ id: "failed-terminal", description: "The export ends in the documented Failed state", polls: [undiscoveredPoll, acceptedPoll, dispatchedPoll, failedPoll, failedPoll], outcome: "terminal", terminalState: Option.some("Failed"), expected: "fail" }),
  Control.make({ id: "status-regression", description: "The status moves from dispatched back to accepted before succeeding", polls: [undiscoveredPoll, dispatchedPoll, acceptedPoll, writingPoll, cleanPoll, cleanPoll], outcome: "terminal", terminalState: succeededState, expected: "fail" }),
  Control.make({ id: "hash-mismatch", description: "The retained artifact bytes do not hash to the recorded SHA-256", polls: [undiscoveredPoll, acceptedPoll, dispatchedPoll, writingPoll, alteredPoll, alteredPoll], outcome: "terminal", terminalState: succeededState, expected: "fail" }),
]

const controlRecord = (result: unknown, index: number) => ProbeRecord.make({ probe: "export-status", phase: `watch:${String(index)}`, subject: "acme", actor: "control", at, status: 200, result: Option.some(result), error: Option.none() })

const verifierFailure = (message: string) => AcceptanceError.make({ boundary: "verifier", message })

const invalidCatalog = flow(String, verifierFailure)

const decodeCatalog = flow(Schema.decodeUnknownEffect(Catalog), Effect.mapError(invalidCatalog))

const withId = (id: string) => (entry: Readonly<{ id: string }>) => Equal.equals(entry.id, id)

const declared = (what: string) => pipe(`The catalog declares no ${what}`, verifierFailure, Function.constant)

/** The declared completion scenario and requirement because the controls must exercise the exact watch and binding the run executes. */
const subjectOf = Effect.fn("ReportExportsAcceptance.completionSubject")(function* () {
  const catalog = yield* decodeCatalog(reportExportsCatalog)
  const scenario = yield* pipe(catalog.scenarios, Array.findFirst(withId(completionScenarioId)), Effect.fromOption, Effect.mapError(declared(completionScenarioId)))
  const declaredRequirement = yield* pipe(catalog.requirements, Array.findFirst(withId(completionRequirementId)), Effect.fromOption, Effect.mapError(declared(completionRequirementId)))

  const requirement = BoundRequirement.make({
    reference: declaredRequirement.id,
    id: declaredRequirement.id,
    revision: declaredRequirement.revision,
    text: declaredRequirement.text,
    category: declaredRequirement.category,
    evaluator: completionEvaluator,
    evaluatorRevision: completionRevision,
  })

  return Tuple.make(scenario, requirement)
})

const contextOf = (scenario: Scenario) => Effect.fn("ReportExportsAcceptance.controlContext")(function* (control: Control) {
  const watch = yield* pipe(scenario.watch, Effect.fromOption, Effect.mapError(declared(`watch on ${scenario.id}`)))
  const input = yield* pipe(scenario.inputs, Array.head, Effect.fromOption, Effect.mapError(declared(`input on ${scenario.id}`)))
  const request = PayloadSchema.make(controlRequest)
  const probes = Array.map(control.polls, controlRecord)
  const record = WatchRecord.make({ watch, startedAt: at, endedAt: at, outcome: control.outcome, terminalState: control.terminalState, polls: Array.length(probes) })
  const candidate = Candidate.make({ inputCase: input.id, operation: input.operation, description: controlLabel, input: request, sources: input.fields, validity: input.validity, nativeValidation: controlLabel, provenance: controlLabel, seed: 0 })
  const submission = Submission.make({ inputCase: input.id, operation: input.operation, input: request, status: 200, result: Option.some(controlResult), error: Option.none(), at, exchange: Option.none(), feedback: Option.none() })

  return EvaluationContext.make({
    scenario,
    fixture: controlFixture,
    candidates: [candidate],
    submissions: [submission],
    before: [],
    after: [],
    probes,
    directProbe: Option.none(),
    barrier: Option.none(),
    watch: Option.some(record),
    interruption: Option.none(),
    evidence: [],
  })
})

const controlFixture = PreparedFixture.make({ binding: "control", revision: "control", url: "about:blank", actor: "control", facts: { "tenant.id": "acme" }, tracked: ["acme"] })

const ResultsSchema = Schema.Array(RequirementResult)

class ControlOutcome extends Schema.Class<ControlOutcome>("CompletionControlOutcome")({
  id: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  expected: ResultStatusSchema,
  results: ResultsSchema,
  falseAcceptance: Schema.Int,
  falseRejection: Schema.Int,
  unexpectedStatuses: Schema.Int,
}) {}

const ControlOutcomesSchema = Schema.Array(ControlOutcome)

const SummaryFields = {
  cases: Schema.Number,
  criteria: Schema.Number,
  falseAcceptance: Schema.Number,
  falseRejection: Schema.Number,
  unexpectedStatuses: Schema.Number,
}

class VerifierSummary extends Schema.Class<VerifierSummary>("ReportExportsVerifierSummary")(SummaryFields) {}

const RoundTripSummarySchema = Schema.Struct(SummaryFields)

interface RoundTripSummary extends Schema.Schema.Type<typeof RoundTripSummarySchema> {}

const RoundTripHeadlineSchema = Schema.Struct({ summary: RoundTripSummarySchema })

interface RoundTripHeadline extends Schema.Schema.Type<typeof RoundTripHeadlineSchema> {}

const RevisionsSchema = Schema.Record(Schema.String, Schema.String)

/**
 * The report retained with every run: the package round-trip verifier's encoded report and the eventual-completion controls, with one
 * summary over both, because the runner refuses a pass whose verifier reports any false verdict.
 */
class VerifierReport extends Schema.Class<VerifierReport>("ReportExportsVerifierReport")({
  evaluators: RevisionsSchema,
  summary: VerifierSummary,
  roundTrip: Schema.Unknown,
  completion: ControlOutcomesSchema,
  limitation: Schema.String,
}) {}

const falselyAccepted = (expected: Status) => (result: RequirementResult) => {
  const pass = Equal.equals(result.status, "pass")
  const shouldNotPass = !Equal.equals(expected, "pass")

  return pass && shouldNotPass
}

const falselyRejected = (expected: Status) => (result: RequirementResult) => {
  const failing = Equal.equals(result.status, "fail")

  return failing && Equal.equals(expected, "pass")
}

const unexpected = (expected: Status) => (result: RequirementResult) => {
  const mismatched = !Equal.equals(result.status, expected)
  const acceptedFalsely = falselyAccepted(expected)(result)
  const rejectedFalsely = falselyRejected(expected)(result)
  const counted = acceptedFalsely || rejectedFalsely
  const uncounted = !counted

  return mismatched && uncounted
}

const verifyControl = (scenario: Scenario, requirement: BoundRequirement) => Effect.fn("ReportExportsAcceptance.verifyControl")(function* (control: Control) {
  const evaluation = yield* RequirementEvaluation
  const context = yield* contextOf(scenario)(control)
  const result = yield* evaluation.evaluate(requirement, context)
  const results = [result]

  return ControlOutcome.make({
    id: control.id,
    description: control.description,
    expected: control.expected,
    results,
    falseAcceptance: Array.countBy(results, falselyAccepted(control.expected)),
    falseRejection: Array.countBy(results, falselyRejected(control.expected)),
    unexpectedStatuses: Array.countBy(results, unexpected(control.expected)),
  })
})

type CountKey = "falseAcceptance" | "falseRejection" | "unexpectedStatuses"

const totalOf = (outcomes: ReadonlyArray<ControlOutcome>, key: CountKey) => pipe(outcomes, Array.map(Struct.get(key)), Number.sumAll)

const decodeHeadline = flow(Schema.decodeUnknownEffect(RoundTripHeadlineSchema), Effect.mapError(invalidCatalog))

const limitation = "Zero false verdicts on these finite constructed controls is not a universal reliability claim; the round-trip controls exercise a package control application, and the five eventual-completion controls exercise constructed watch records of the declared generate-export-completes watch, not a live worker."

/** Judges every constructed control with the real evaluation service because the runner refuses a pass whose verifier reports a false verdict. */
export const verifyDefects = Effect.fn("ReportExportsAcceptance.verifyDefects")(function* () {
  const roundTripReport = yield* roundTripVerifier
  const { summary: prior }: RoundTripHeadline = yield* decodeHeadline(roundTripReport)
  const [scenario, requirement] = yield* subjectOf()
  const completion = yield* Effect.forEach(controls, verifyControl(scenario, requirement))

  const summary = VerifierSummary.make({
    cases: prior.cases + Array.length(completion),
    criteria: prior.criteria + Array.length(completion),
    falseAcceptance: prior.falseAcceptance + totalOf(completion, "falseAcceptance"),
    falseRejection: prior.falseRejection + totalOf(completion, "falseRejection"),
    unexpectedStatuses: prior.unexpectedStatuses + totalOf(completion, "unexpectedStatuses"),
  })

  return VerifierReport.make({ evaluators: evaluatorRevisions, summary, roundTrip: roundTripReport, completion, limitation })
}, Effect.provide(evaluationLayer))

const encodeReport = flow(Schema.encodeEffect(VerifierReport), Effect.mapError(invalidCatalog))

/** The encoded report is what run.json and verifier.json retain because the runner decodes only its summary counts. */
export const verifier = Effect.fn("ReportExportsAcceptance.verifier")(function* () {
  const report = yield* verifyDefects()

  return yield* encodeReport(report)
})()
