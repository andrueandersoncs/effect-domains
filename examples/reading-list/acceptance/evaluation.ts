import { Array, Effect, Equal, Function, HashMap, HashSet, Layer, Number, Option, Predicate, Record, Result, Schema, String, Struct, flow, pipe } from "effect"
import type { ParseOptions } from "effect/SchemaAST"
import { AcceptanceError, Candidate, EvaluationContext, InputCase, Observation, PayloadSchema, type Requirement, RequirementEvaluation, RequirementResult, ResultStatusSchema, Scenario, Submission, type Payload } from "@effect-domains/acceptance/model"
import { ReadingListApplication } from "../application.ts"
import { ReadingListBookSchema } from "../domain.ts"

type Status = typeof ResultStatusSchema.Type
type Resource = typeof ReadingListApplication.resources[number]

class Assertion extends Schema.Class<Assertion>("Assertion")({
  status: ResultStatusSchema,
  explanation: Schema.String,
}) {}

type Verdict<A> = Effect.Effect<A, Assertion>

const DecodedSchema = Schema.Option(Schema.Unknown)

/** The evaluated subject is the single required submission with its views because every Reading List scenario has exactly one obligation-bearing input. */
class Subject extends Schema.Class<Subject>("Subject")({
  context: EvaluationContext,
  input: InputCase,
  candidate: Candidate,
  submission: Submission,
  before: Observation,
  after: Observation,
  sentinel: PayloadSchema,
  decoded: DecodedSchema,
}) {}

const operations = pipe(ReadingListApplication.group.requests.values(), Array.fromIterable)

type Operation = typeof operations[number]

const failUnless = (condition: boolean, assertion: Assertion): Verdict<boolean> => condition ? Effect.succeed(condition) : Effect.fail(assertion)

const present = (assertion: Assertion) => <A>(option: Option.Option<A>): Verdict<A> => {
  const failure = Effect.fail(assertion)

  return Option.match(option, { onNone: Function.constant(failure), onSome: Effect.succeed })
}

const assertWhen = (condition: boolean) => (assertion: Assertion) => condition ? Option.some(assertion) : Option.none<Assertion>()
const isPayload = Schema.is(PayloadSchema)
const bookFields = Record.keys(ReadingListBookSchema.fields)
const byId = (id: unknown) => (row: Payload) => Equal.equals(row.id, id)
const rowById = (rows: ReadonlyArray<Payload>) => (id: unknown) => Array.findFirst(rows, byId(id))
const byName = (name: string) => (resource: Resource) => Equal.equals(resource.name, name)
const byTag = (tag: string) => (operation: Operation) => Equal.equals(operation._tag, tag)
const byInputCase = (id: string) => (entry: Candidate | Submission) => Equal.equals(entry.inputCase, id)
const byInputId = (id: string) => (input: InputCase) => Equal.equals(input.id, id)
const byResource = (name: string) => (view: Observation) => Equal.equals(view.resource, name)
const describeRow = (row: Payload) => globalThis.String(row.id)
const exactPayload: ParseOptions = { onExcessProperty: "error" }

const creationDefaults = pipe(
  ReadingListApplication.resources,
  Array.findFirst(byName("books")),
  Option.map(flow(Struct.get("creation"), Struct.get("defaults"))),
  Option.filter(isPayload),
)

const identity = (row: Payload) => pipe(row, Record.get("id"), Option.filter(Predicate.isString), Option.filter(String.isNonEmpty))
const isIdentified = flow(identity, Option.isSome)

const notCaptured = Assertion.make({ status: "inconclusive", explanation: "No actual browser submission response was captured." })
const unrequired = Assertion.make({ status: "blocked", explanation: "The scenario declares no required input case to evaluate." })
const foreignResource = Assertion.make({ status: "blocked", explanation: "This evaluator binds only to the books resource." })
const unresolvedCandidate = Assertion.make({ status: "blocked", explanation: "No resolved candidate was recorded for the required input." })
const mismatchedSubmission = Assertion.make({ status: "fail", explanation: "The captured submission does not match the bound operation and concrete candidate." })
const unidentifiedSentinel = Assertion.make({ status: "blocked", explanation: "The sentinel fixture has no stable identity." })
const missingSentinel = Assertion.make({ status: "inconclusive", explanation: "The before view does not establish the exact seeded sentinel." })
const notAcceptedScenario = Assertion.make({ status: "blocked", explanation: "This criterion requires an accepted-input scenario." })
const unvalidatedCandidate = Assertion.make({ status: "blocked", explanation: "The candidate was not validated for the native accepted operation path." })
const rejectedValid = Assertion.make({ status: "fail", explanation: "The valid candidate was rejected by the application." })
const undeclaredResponse = Assertion.make({ status: "inconclusive", explanation: "The response does not establish application acceptance or declared rejection." })
const erroredAcceptance = Assertion.make({ status: "fail", explanation: "The acceptance response contains an application error." })
const resultlessAcceptance = Assertion.make({ status: "inconclusive", explanation: "The acceptance response has no decoded operation result." })
const replacedIdentity = Assertion.make({ status: "fail", explanation: "The new row does not match the captured created identity." })
const unboundTarget = Assertion.make({ status: "blocked", explanation: "The update candidate is not bound to a stable fixture target." })
const unestablishedTarget = Assertion.make({ status: "inconclusive", explanation: "The before view does not establish the exact update target." })
const absentTarget = Assertion.make({ status: "fail", explanation: "The bound target is missing from the loaded after view." })
const unboundOperation = Assertion.make({ status: "blocked", explanation: "Only books.create and books.update are bound to these assertions." })
const undecodedCandidate = Assertion.make({ status: "blocked", explanation: "The native decoded candidate is not a book payload." })
const unavailableDefaults = Assertion.make({ status: "blocked", explanation: "The native compiled creation defaults are unavailable." })
const notCreation = Assertion.make({ status: "blocked", explanation: "Creation values require a books.create scenario." })
const notReloaded = Assertion.make({ status: "inconclusive", explanation: "No actual reloaded observation was captured." })
const uncapturedCreation = Assertion.make({ status: "inconclusive", explanation: "The identity created before reload was not captured." })
const notRejectedScenario = Assertion.make({ status: "blocked", explanation: "Rejection preservation requires a rejected-input scenario." })
const acceptedInvalid = Assertion.make({ status: "fail", explanation: "The invalid candidate was accepted instead of rejected." })
const undeclaredRejection = Assertion.make({ status: "inconclusive", explanation: "The response does not establish an application rejection; transport or internal errors are not rejection evidence." })
const evidencelessRejection = Assertion.make({ status: "inconclusive", explanation: "The rejection response has no decoded evidence." })
const preservedRejection = Assertion.make({ status: "pass", explanation: "The application rejected the concrete candidate and every row is exactly unchanged by stable identity." })
const unavailableOperation = Assertion.make({ status: "blocked", explanation: "The native accepted operation is unavailable." })

const blockedBy = (interruption: string) => Assertion.make({ status: "blocked", explanation: `Submission was prevented: ${interruption}` })

const repeatedSubmission = (count: number) => Assertion.make({ status: "inconclusive", explanation: `The required input was submitted ${count} times; exactly one submission is required.` })

const checkedView = (label: string, unloaded: Assertion) => (view: Observation) => {
  const whole = Array.every([view.loaded, view.unfiltered], Boolean)
  const ids = Array.map(view.rows, identity)
  const identified = Array.getSomes(ids)
  const distinct = HashSet.fromIterable(identified)
  const idCount = Array.length(ids)
  const identifiedCount = Array.length(identified)
  const distinctCount = HashSet.size(distinct)
  const allIdentified = Equal.equals(identifiedCount, idCount)
  const unique = Equal.equals(distinctCount, identifiedCount)
  const identifiable = allIdentified && unique
  const unidentified = Assertion.make({ status: "inconclusive", explanation: `${label} has missing or duplicate stable row identities.` })

  if (!whole) return Effect.fail(unloaded)

  return identifiable ? Effect.succeed(view) : Effect.fail(unidentified)
}

const booksView = (label: string, observations: ReadonlyArray<Observation>) => {
  const unloaded = Assertion.make({ status: "inconclusive", explanation: `${label} is not a loaded, unfiltered books observation.` })

  return pipe(observations, Array.findFirst(byResource("books")), present(unloaded), Effect.flatMap(checkedView(label, unloaded)))
}

const establishedSentinel = Effect.fn("ReadingListAcceptance.sentinel")(function* (context: EvaluationContext, before: Observation) {
  const fact = pipe(context.fixture.facts, Record.get("sentinel"), Option.filter(isPayload))
  const sentinel = yield* pipe(fact, Option.filter(isIdentified), present(unidentifiedSentinel))
  const baseline = rowById(before.rows)(sentinel.id)
  const established = Option.exists(baseline, Equal.equals(sentinel))

  yield* failUnless(established, missingSentinel)

  return sentinel
})

const declaredInput = (scenario: Scenario) => (id: string) => Array.findFirst(scenario.inputs, byInputId(id))

const prerequisite = Effect.fn("ReadingListAcceptance.prerequisite")(function* (context: EvaluationContext) {
  const required = pipe(context.scenario.required, Array.head, Option.flatMap(declaredInput(context.scenario)))
  const input = yield* present(unrequired)(required)
  const submissions = Array.filter(context.submissions, byInputCase(input.id))
  const count = Array.length(submissions)
  const missing = Option.match(context.interruption, { onNone: Function.constant(notCaptured), onSome: blockedBy })
  const submission = yield* pipe(submissions, Array.head, present(missing))
  const single = Equal.equals(count, 1)
  const repeated = repeatedSubmission(count)

  yield* failUnless(single, repeated)

  const books = Array.contains(context.scenario.observations, "books")

  yield* failUnless(books, foreignResource)

  const candidate = yield* pipe(context.candidates, Array.findFirst(byInputCase(input.id)), present(unresolvedCandidate))
  const sameOperation = Equal.equals(submission.operation, candidate.operation)
  const sameInput = Equal.equals(submission.input, candidate.input)
  const matches = sameOperation && sameInput

  yield* failUnless(matches, mismatchedSubmission)

  const before = yield* booksView("Before view", context.before)
  const after = yield* booksView("After view", context.after)
  const sentinel = yield* establishedSentinel(context, before)

  return Subject.make({ context, input, candidate, submission, before, after, sentinel, decoded: Option.none() })
})

const withinSuccessRange = Number.between({ minimum: 200, maximum: 299 })
const withinClientErrorRange = Number.between({ minimum: 400, maximum: 499 })
const isCreating = (subject: Subject) => Equal.equals(subject.input.operation, "books.create")
const isUpdating = (subject: Subject) => Equal.equals(subject.input.operation, "books.update")

const acceptedProblem = (subject: Subject) => {
  const { submission } = subject
  const accepted = Equal.equals(subject.input.outcome.kind, "accepted")
  const valid = Equal.equals(subject.candidate.validity, "native-valid")
  const rejected = withinClientErrorRange(submission.status)
  const successful = withinSuccessRange(submission.status)
  const errored = Option.isSome(submission.error)
  const resultMissing = Option.isNone(submission.result)
  const scenarioProblem = assertWhen(!accepted)(notAcceptedScenario)
  const candidateProblem = assertWhen(!valid)(unvalidatedCandidate)
  const rejectionProblem = assertWhen(rejected)(rejectedValid)
  const statusProblem = assertWhen(!successful)(undeclaredResponse)
  const errorProblem = assertWhen(errored)(erroredAcceptance)
  const resultProblem = assertWhen(resultMissing)(resultlessAcceptance)

  return Option.firstSomeOf([scenarioProblem, candidateProblem, rejectionProblem, statusProblem, errorProblem, resultProblem])
}

// The created identity is the 2xx create result's id because the runner retains the submission, not a separate capture.
const createdIdentity = (subject: Subject) => {
  const successful = withinSuccessRange(subject.submission.status)
  const captured = isCreating(subject) && successful
  const identified = pipe(subject.submission.result, Option.filter(isPayload), Option.flatMap(identity))

  return captured ? identified : Option.none<string>()
}

const freshIn = (beforeIds: HashSet.HashSet<Option.Option<unknown>>) => (row: Payload) => {
  const id = Record.get(row, "id")

  return !HashSet.has(beforeIds, id)
}

const matchingCreated = (created: Option.Option<string>) => (row: Payload) => {
  const replaced = Option.exists(created, Predicate.not(Equal.equals(row.id)))

  return replaced ? Result.fail(replacedIdentity) : Result.succeed(row)
}

const createdRow = (subject: Subject, after: Observation) => {
  const beforeIds = pipe(subject.before.rows, Array.map(Record.get("id")), HashSet.fromIterable)
  const fresh = Array.filter(after.rows, freshIn(beforeIds))
  const count = Array.length(fresh)
  const single = Equal.equals(count, 1)
  const only = single ? Array.head(fresh) : Option.none<Payload>()
  const missing = Assertion.make({ status: "fail", explanation: `Expected one newly identified book; observed ${count}.` })
  const created = createdIdentity(subject)

  return pipe(only, Result.fromOption(Function.constant(missing)), Result.flatMap(matchingCreated(created)))
}

const targetRow = (subject: Subject, view: Observation) => {
  const { facts } = subject.context.fixture
  const target = pipe(facts, Record.get("target"), Option.filter(isPayload))
  const id = pipe(facts, Record.get("target.id"), Option.filter(Predicate.isString), Option.filter(String.isNonEmpty))
  const bound = Option.filter(id, Equal.equals(subject.candidate.input.id))
  const baseline = Option.flatMap(bound, rowById(subject.before.rows))
  const established = Equal.equals(baseline, target)
  const observed = Option.flatMap(bound, rowById(view.rows))
  const unbound = Option.isNone(bound)

  if (unbound) return Result.fail(unboundTarget)

  return established ? Result.fromOption(observed, Function.constant(absentTarget)) : Result.fail(unestablishedTarget)
}

const expectedRow = (subject: Subject, after: Observation) => {
  if (isCreating(subject)) return createdRow(subject, after)

  return isUpdating(subject) ? targetRow(subject, after) : Result.fail(unboundOperation)
}

const fieldDiffers = (subject: Subject, row: Payload, input: Payload, defaults: Payload) => (field: string) => {
  const omitted = !Record.has(input, field)
  const defaulted = isCreating(subject) && omitted
  const expected = defaulted ? Record.get(defaults, field) : Record.get(input, field)
  const absent = !Record.has(row, field)
  const observed = Record.get(row, field)
  const changed = !Equal.equals(observed, expected)

  return absent || changed
}

const compareRow = (subject: Subject) => (row: Payload) => {
  const input = Option.filter(subject.decoded, isPayload)

  if (Option.isNone(input)) return undecodedCandidate

  if (Option.isNone(creationDefaults)) return unavailableDefaults

  const differences = Array.filter(bookFields, fieldDiffers(subject, row, input.value, creationDefaults.value))
  const listed = Array.join(differences, ", ")
  const book = describeRow(row)
  const identical = Array.isReadonlyArrayEmpty(differences)

  return identical
    ? Assertion.make({ status: "pass", explanation: `Book ${book} has every submitted domain value, including its rating.` })
    : Assertion.make({ status: "fail", explanation: `Book ${book} differs from the concrete candidate in: ${listed}.` })
}

const acceptedValues = (subject: Subject): Assertion => {
  const problem = acceptedProblem(subject)
  const row = expectedRow(subject, subject.after)
  const verdict = Result.match(row, { onFailure: Function.identity, onSuccess: compareRow(subject) })

  return Option.getOrElse(problem, Function.constant(verdict))
}

const createdValues = (subject: Subject) => isCreating(subject) ? acceptedValues(subject) : notCreation

const reloadVisible = (subject: Subject): Assertion => {
  const unidentified = pipe(subject, createdIdentity, Option.isNone)
  const identityMissing = isCreating(subject) && unidentified

  if (!subject.after.reloaded) return notReloaded

  return identityMissing ? uncapturedCreation : acceptedValues(subject)
}

const rejectionStatuses = [400, 403, 422]

const unchangedIn = (rows: ReadonlyArray<Payload>) => (row: Payload) => {
  const observed = rowById(rows)(row.id)

  return Option.exists(observed, Equal.equals(row))
}

const rejectedAttempt = (subject: Subject): Assertion => {
  const { submission } = subject
  const rejected = Equal.equals(subject.input.outcome.kind, "rejected")
  const target = isUpdating(subject) ? targetRow(subject, subject.before) : Result.succeed(subject.sentinel)
  const changed = Array.filter(subject.before.rows, Predicate.not(unchangedIn(subject.after.rows)))
  const changedIds = pipe(changed, Array.map(describeRow), Array.join(", "))
  const noneChanged = String.isEmpty(changedIds)
  const changedLabel = noneChanged ? "none" : changedIds
  const beforeCount = Array.length(subject.before.rows)
  const afterCount = Array.length(subject.after.rows)
  const resized = !Equal.equals(beforeCount, afterCount)
  const mutated = Array.isReadonlyArrayNonEmpty(changed)
  const altered = mutated || resized
  const successful = withinSuccessRange(submission.status)
  const errorless = Option.isNone(submission.error)
  const accepted = successful && errorless
  const declared = Array.contains(rejectionStatuses, submission.status)
  const resultless = Option.isNone(submission.result)
  const evidenceless = errorless && resultless
  const alteredRows = Assertion.make({ status: "fail", explanation: `Rejected attempt changed, removed, or added rows; changed original identities: ${changedLabel}.` })
  const rowsProblem = assertWhen(altered)(alteredRows)
  const acceptanceProblem = assertWhen(accepted)(acceptedInvalid)
  const statusProblem = assertWhen(!declared)(undeclaredRejection)
  const evidenceProblem = assertWhen(evidenceless)(evidencelessRejection)
  const problem = Option.firstSomeOf([rowsProblem, acceptanceProblem, statusProblem, evidenceProblem])

  if (!rejected) return notRejectedScenario

  return Result.isFailure(target) ? target.failure : Option.getOrElse(problem, Function.constant(preservedRejection))
}

const sentinelUnchanged = (subject: Subject): Assertion => {
  const after = rowById(subject.after.rows)(subject.sentinel.id)
  const preserved = Option.exists(after, Equal.equals(subject.sentinel))
  const sentinel = describeRow(subject.sentinel)

  return preserved
    ? Assertion.make({ status: "pass", explanation: `Sentinel ${sentinel} remains present with every field unchanged.` })
    : Assertion.make({ status: "fail", explanation: `Sentinel ${sentinel} was mutated or deleted.` })
}

const evaluators = HashMap.make(
  ["created-values", createdValues],
  ["reload-visible", reloadVisible],
  ["accepted-rating", acceptedValues],
  ["rejection-unchanged", rejectedAttempt],
  ["sentinel-unchanged", sentinelUnchanged],
)

export const evaluatorNames = pipe(evaluators, HashMap.keys, Array.fromIterable)

const withDecoded = (subject: Subject) => (decoded: unknown) => Subject.make({ ...subject, decoded: Option.some(decoded) })

const nativeRejection = (error: Schema.SchemaError) => Assertion.make({ status: "blocked", explanation: `Native operation validation rejected the accepted-path candidate: ${error.message}` })

const revalidate = Effect.fn("ReadingListAcceptance.revalidate")(function* (subject: Subject) {
  const operation = Array.findFirst(operations, byTag(subject.input.operation))

  if (Option.isNone(operation)) return Result.fail(unavailableOperation)

  const decode = Schema.decodeUnknownEffect(operation.value.payloadSchema, exactPayload)
  const decoded = yield* pipe(subject.candidate.input, decode, Effect.result)

  return pipe(decoded, Result.map(withDecoded(subject)), Result.mapError(nativeRejection))
})

const resultFor = (requirement: Requirement, context: EvaluationContext) => (verdict: Assertion) => RequirementResult.make({
  requirement: requirement.id,
  scenario: context.scenario.id,
  evaluator: requirement.evaluator,
  status: verdict.status,
  explanation: verdict.explanation,
  evidence: context.evidence,
})

const evaluate = Effect.fn("ReadingListAcceptance.evaluate")(function* (requirement: Requirement, context: EvaluationContext) {
  const evaluator = HashMap.get(evaluators, requirement.evaluator)
  const report = resultFor(requirement, context)

  if (Option.isNone(evaluator)) return yield* AcceptanceError.make({ boundary: "requirement-evaluation", message: `Unknown evaluator: ${requirement.evaluator}` })

  const prepared = yield* pipe(context, prerequisite, Effect.result)

  if (Result.isFailure(prepared)) return report(prepared.failure)

  const accepted = Equal.equals(prepared.success.input.outcome.kind, "accepted")
  const behavioral = !Equal.equals(requirement.evaluator, "sentinel-unchanged")
  const nativePath = accepted && behavioral
  const evaluated = nativePath ? yield* revalidate(prepared.success) : Result.succeed(prepared.success)
  const verdict = pipe(evaluated, Result.map(evaluator.value), Result.merge)

  return report(verdict)
})

const evaluationService = RequirementEvaluation.of({ evaluate })

export const evaluationLayer = Layer.succeed(RequirementEvaluation, evaluationService)
