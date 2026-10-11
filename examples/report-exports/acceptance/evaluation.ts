import { Array, Context, Effect, Equal, Function, HashMap, Layer, Match, Number, Option, Order, Record, Schema, String as Text, Struct, pipe } from "effect"
import { AcceptanceError, EvaluationContext, InputCase, PayloadSchema, ProbeRecord, Requirement, RequirementEvaluation, RequirementResult, ResultStatusSchema, Submission, type Payload } from "@effect-domains/acceptance/model"
import { StoredExportsSchema, type StoredExport } from "./fixture.ts"

type Status = typeof ResultStatusSchema.Type

class Verdict extends Schema.Class<Verdict>("ReportExportsVerdict")({
  status: ResultStatusSchema,
  explanation: Schema.String,
}) {}

const verdict = (status: Status) => (explanation: string) => Verdict.make({ status, explanation })

const passed = verdict("pass")

const failed = verdict("fail")

const inconclusive = verdict("inconclusive")

const storedExports = "stored-exports"

const outcomeEvaluator = "declared-outcome"

const storedEvaluator = "stored-request"

const generatedEvaluator = "generated-excluded"

const unchangedEvaluator = "store-unchanged"

export const evaluators = [outcomeEvaluator, storedEvaluator, generatedEvaluator, unchangedEvaluator]

const generatedFields = ["executionId", "tenantId"]

export const codecServices = Context.empty()

const withinSuccess = Number.between({ minimum: 200, maximum: 299 })

const rejectionStatuses = [400, 422]

const TaggedSchema = Schema.Struct({ _tag: Schema.String })

interface Tagged extends Schema.Schema.Type<typeof TaggedSchema> {}

const decodeTagged: (error: unknown) => Option.Option<Tagged> = Schema.decodeUnknownOption(TaggedSchema)

const tagOf = (submission: Submission) => pipe(submission.error, Option.flatMap(decodeTagged), Option.map(Struct.get("_tag")))

const StoredRowsSchema = Schema.toType(StoredExportsSchema)

const decodeStored = Schema.decodeUnknownOption(StoredRowsSchema)

const decodeExecutionId = Schema.decodeUnknownOption(Schema.String)

const isRecord = Schema.is(PayloadSchema)

const emptyFields: Payload = {}

const noItems: ReadonlyArray<unknown> = []

const itemsOf = (container: unknown) => Array.isArray(container) ? container : noItems

const fieldsOf = (container: unknown) => isRecord(container) ? container : emptyFields

/** Whether every value of `value` appears at the same place in `container`, because the store may add fields but must keep each submitted one. */
const contained = (container: unknown, value: unknown): boolean => {
  const items = itemsOf(container)
  const fields = fieldsOf(container)

  if (Array.isArray(value)) return arrayContained(items, value)

  return isRecord(value) ? recordContained(fields, value) : Equal.equals(container, value)
}

const pairContained = ([left, right]: readonly [unknown, unknown]) => contained(left, right)

const arrayContained = (items: ReadonlyArray<unknown>, value: ReadonlyArray<unknown>) => {
  const sameLength = Equal.equals(items.length, value.length)
  const pairs = Array.zip(items, value)

  return sameLength && Array.every(pairs, pairContained)
}

const memberContained = (fields: Payload) => ([key, member]: readonly [string, unknown]) => {
  const held = Record.get(fields, key)

  return Option.exists(held, (candidate) => contained(candidate, member))
}

const recordContained = (fields: Payload, value: Payload) => {
  const entries = Record.toEntries(value)

  return Array.every(entries, memberContained(fields))
}

const submittedFor = (input: InputCase) => (submission: Submission) => Equal.equals(submission.inputCase, input.id)

const submissionOf = (context: EvaluationContext, input: InputCase) => Array.findFirst(context.submissions, submittedFor(input))

const requiredBy = (context: EvaluationContext) => (input: InputCase) => Array.contains(context.scenario.required, input.id)

const requiredInputs = (context: EvaluationContext) => Array.filter(context.scenario.inputs, requiredBy(context))

const uncaptured = Function.constant("no browser submission was captured")

const notSubmitted = (context: EvaluationContext, input: InputCase) => () => {
  const reason = Option.getOrElse(context.interruption, uncaptured)
  const status: Status = Option.isSome(context.interruption) ? "blocked" : "inconclusive"

  return Verdict.make({ status, explanation: `${input.id} was not submitted: ${reason}` })
}

const noTag = Function.constant("no tagged failure")

const outcomeOf = (input: InputCase) => (submission: Submission) => {
  const status = String(submission.status)
  const accepted = withinSuccess(submission.status)
  const rejected = Array.contains(rejectionStatuses, submission.status)
  const tag = tagOf(submission)
  const seen = Option.getOrElse(tag, noTag)
  const acceptedVerdict = () => accepted ? passed(`${input.id} was accepted with HTTP ${status}.`) : failed(`${input.id} was declared accepted but answered HTTP ${status}.`)
  const rejectedVerdict = () => rejected ? passed(`${input.id} was rejected with HTTP ${status}.`) : failed(`${input.id} was declared rejected but answered HTTP ${status}.`)
  const deniedVerdict = ({ failure }: Readonly<{ failure: string }>) => Option.contains(tag, failure) ? passed(`${input.id} was refused with ${failure}.`) : failed(`${input.id} was declared denied with ${failure} but answered HTTP ${status} (${seen}).`)

  return pipe(Match.value(input.outcome), Match.discriminatorsExhaustive("kind")({ accepted: acceptedVerdict, rejected: rejectedVerdict, denied: deniedVerdict }))
}

const declaredOutcome = (context: EvaluationContext) => (input: InputCase) => pipe(
  submissionOf(context, input),
  Option.match({ onNone: notSubmitted(context, input), onSome: outcomeOf(input) }),
)

const isStoreProbe = (record: ProbeRecord) => Equal.equals(record.probe, storedExports)

const isAfterStore = (record: ProbeRecord) => isStoreProbe(record) && Text.startsWith("after")(record.phase)

const isBeforeStore = (record: ProbeRecord) => isStoreProbe(record) && Equal.equals(record.phase, "before")

const storedRows = (record: ProbeRecord) => Option.flatMap(record.result, decodeStored)

const afterRows = (context: EvaluationContext) => pipe(context.probes, Array.findLast(isAfterStore), Option.flatMap(storedRows))

const beforeRows = (context: EvaluationContext) => pipe(context.probes, Array.findFirst(isBeforeStore), Option.flatMap(storedRows))

const storedUnder = (id: string) => (stored: StoredExport) => Equal.equals(stored.id, id)

const requestKept = (submission: Submission, id: string) => (stored: StoredExport) => contained(stored.request, submission.input)
  ? passed(`The request stored for ${id} holds every submitted value.`)
  : failed(`The request stored for ${id} differs from the submitted request.`)

const keptIn = (submission: Submission, id: string) => (rows: ReadonlyArray<StoredExport>) => pipe(
  Array.findFirst(rows, storedUnder(id)),
  Option.match({ onNone: () => failed(`No stored export request has the returned execution id ${id}.`), onSome: requestKept(submission, id) }),
)

const storedAs = (context: EvaluationContext, input: InputCase, submission: Submission) => (id: string) => pipe(
  afterRows(context),
  Option.match({ onNone: () => inconclusive(`No readable after-submission ${storedExports} probe was recorded for ${input.id}.`), onSome: keptIn(submission, id) }),
)

const storedSubmission = (context: EvaluationContext, input: InputCase) => (submission: Submission) => {
  const status = String(submission.status)
  const missingId = () => failed(`${input.id} returned no execution id (HTTP ${status}).`)

  return pipe(
    submission.result,
    Option.flatMap(decodeExecutionId),
    Option.match({ onNone: missingId, onSome: storedAs(context, input, submission) }),
  )
}

const storedRequest = (context: EvaluationContext) => (input: InputCase) => pipe(
  submissionOf(context, input),
  Option.match({ onNone: notSubmitted(context, input), onSome: storedSubmission(context, input) }),
)

const suppliedIn = (submission: Submission) => (field: string) => Record.has(submission.input, field)

const generatedExcluded = (input: InputCase) => (submission: Submission) => {
  const supplied = Array.filter(generatedFields, suppliedIn(submission))
  const listed = Array.join(supplied, ", ")

  return Array.isReadonlyArrayEmpty(supplied) ? passed(`${input.id} supplied no server-generated field.`) : failed(`${input.id} supplied server-generated fields: ${listed}.`)
}

const generatedIgnored = (context: EvaluationContext) => (input: InputCase) => pipe(
  submissionOf(context, input),
  Option.match({ onNone: notSubmitted(context, input), onSome: generatedExcluded(input) }),
)

const compared = (before: ReadonlyArray<StoredExport>) => (after: ReadonlyArray<StoredExport>) => {
  const unchanged = contained(before, after) && contained(after, before)
  const from = String(before.length)
  const to = String(after.length)

  return unchanged ? passed(`The ${from} stored export requests are unchanged.`) : failed(`The stored export requests changed (${from} rows before, ${to} after).`)
}

const unrecorded = () => inconclusive(`The ${storedExports} probe was not recorded both before and after the submission.`)

const storeUnchanged = (context: EvaluationContext) => {
  const before = beforeRows(context)
  const after = afterRows(context)
  const judged = Option.zipWith(before, after, (left, right) => compared(left)(right))

  return Option.getOrElse(judged, unrecorded)
}

const ranks: Readonly<Record<Status, number>> = { fail: 0, blocked: 1, inconclusive: 2, pass: 3 }

const rank = (judged: Verdict) => ranks[judged.status]

const byRank = Order.mapInput(Number.Order, rank)

const noInputs = () => inconclusive("The scenario declares no required input.")

const explained = (verdicts: Array.NonEmptyReadonlyArray<Verdict>) => {
  const explanation = pipe(verdicts, Array.map(Struct.get("explanation")), Array.join(" "))
  const worst = Array.min(verdicts, byRank)

  return Verdict.make({ status: worst.status, explanation })
}

const combined = (verdicts: ReadonlyArray<Verdict>) => Array.match(verdicts, { onEmpty: noInputs, onNonEmpty: explained })

const perInput = (judge: (context: EvaluationContext) => (input: InputCase) => Verdict) => (context: EvaluationContext) => pipe(
  requiredInputs(context),
  Array.map(judge(context)),
  combined,
)

const judges = HashMap.make(
  [outcomeEvaluator, perInput(declaredOutcome)],
  [storedEvaluator, perInput(storedRequest)],
  [generatedEvaluator, perInput(generatedIgnored)],
  [unchangedEvaluator, storeUnchanged],
)

const unknownEvaluator = (requirement: Requirement) => () => AcceptanceError.make({ boundary: "evaluation", message: `Unknown evaluator ${requirement.evaluator}` })

const evaluate = Effect.fn("ReportExportsAcceptance.evaluate")(function* (requirement: Requirement, context: EvaluationContext) {
  const found = HashMap.get(judges, requirement.evaluator)
  const judge = yield* pipe(found, Effect.fromOption, Effect.mapError(unknownEvaluator(requirement)))
  const judged = judge(context)

  return RequirementResult.make({ requirement: requirement.id, scenario: context.scenario.id, evaluator: requirement.evaluator, status: judged.status, explanation: judged.explanation, evidence: context.evidence })
})

const service = RequirementEvaluation.of({ evaluate })

export const evaluationLayer = Layer.succeed(RequirementEvaluation, service)
