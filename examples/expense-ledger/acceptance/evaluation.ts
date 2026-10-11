import { Array, Effect, Equal, Equivalence, Layer, Match, Number, Option, Predicate, Record, Schema, Struct, pipe } from "effect"
import { type EvaluationContext, type Candidate, type InputCase, type Requirement, RequirementEvaluation, RequirementResult, ResultStatusSchema, type Submission } from "@effect-domains/acceptance/model"

/** The evaluator names this layer implements, because the catalog may only bind evaluators that exist. */
export const evaluators = ["declared-outcome", "recorded-echo", "observation-unchanged"]

class Verdict extends Schema.Class<Verdict>("ExpenseLedgerVerdict")({
  status: ResultStatusSchema,
  explanation: Schema.String,
}) {}

const pass = (explanation: string) => Verdict.make({ status: "pass", explanation })

const fail = (explanation: string) => Verdict.make({ status: "fail", explanation })

const blocked = (explanation: string) => Verdict.make({ status: "blocked", explanation })

const withinSuccess = Number.between({ minimum: 200, maximum: 299 })

const isPass = (verdict: Verdict) => Equivalence.strictEqual<string>()(verdict.status, "pass")

const forInputCase = (id: string) => (entry: Submission | Candidate) => Equivalence.strictEqual<string>()(entry.inputCase, id)

const inputCaseNamed = (id: string) => (input: InputCase) => Equivalence.strictEqual<string>()(input.id, id)

const submissionFor = (context: EvaluationContext, id: string) => Array.findFirst(context.submissions, forInputCase(id))

const inputCaseFor = (context: EvaluationContext, id: string) => Array.findFirst(context.scenario.inputs, inputCaseNamed(id))

const candidateFor = (context: EvaluationContext, id: string) => Array.findFirst(context.candidates, forInputCase(id))

const failureTag = (submission: Submission) => {
  const error = Option.getOrUndefined(submission.error)

  return Predicate.hasProperty(error, "_tag") ? Option.some(error._tag) : Option.none()
}

const deniedWith = (submission: Submission, failure: string) => {
  const refused = !withinSuccess(submission.status)
  const tag = failureTag(submission)
  const expected = Option.some(failure)
  const tagged = Equal.equals(tag, expected)

  return refused && tagged
}

type DeniedOutcome = Extract<InputCase["outcome"], { readonly kind: "denied" }>

const acceptedOutcome = (submission: Submission) => () => withinSuccess(submission.status)

const rejectedOutcome = (submission: Submission) => () => Equivalence.strictEqual<number>()(submission.status, 400)

const deniedOutcome = (submission: Submission) => (outcome: DeniedOutcome) => deniedWith(submission, outcome.failure)

const matchesOutcome = (input: InputCase, submission: Submission) =>
  pipe(
    Match.value(input.outcome),
    Match.discriminatorsExhaustive("kind")({
      accepted: acceptedOutcome(submission),
      rejected: rejectedOutcome(submission),
      denied: deniedOutcome(submission),
    }),
  )

const notSubmitted = (id: string) => blocked(`Input ${id} was not submitted`)

const sameInput = (submission: Submission) => (candidate: Candidate) => Equal.equals(submission.input, candidate.input)

const judgeSubmitted = (input: InputCase, submission: Submission, offered: Option.Option<Candidate>) => {
  const exact = Option.exists(offered, sameInput(submission))
  const declared = matchesOutcome(input, submission)
  const status = String(submission.status)
  const exactText = String(exact)
  const declaredText = String(declared)
  const held = exact && declared

  return held ? pass(`Input ${input.id} answered HTTP ${status} as declared`) : fail(`Input ${input.id} answered HTTP ${status}; exact input ${exactText}, declared outcome ${declaredText}`)
}

const judgeOutcome = (context: EvaluationContext) => (id: string) => {
  const input = inputCaseFor(context, id)
  const submission = submissionFor(context, id)
  const offered = candidateFor(context, id)
  const both = Option.all([input, submission])

  return Option.match(both, { onNone: () => notSubmitted(id), onSome: ([declared, submitted]) => judgeSubmitted(declared, submitted, offered) })
}

const echoes = (submission: Submission) => {
  const recorded = Option.getOrUndefined(submission.result)
  const isRecord = Predicate.isObject(recorded)

  return isRecord && Record.every(submission.input, (value, key) => Predicate.hasProperty(recorded, key) && Equal.equals(recorded[key], value))
}

const judgeEchoed = (id: string) => (submission: Submission) => echoes(submission) ? pass(`The recorded expense for ${id} echoes every submitted value`) : fail(`The recorded expense for ${id} does not echo the submitted values`)

const judgeEcho = (context: EvaluationContext) => (id: string) => {
  const submission = submissionFor(context, id)

  return Option.match(submission, { onNone: () => notSubmitted(id), onSome: judgeEchoed(id) })
}

const judgeUnchanged = (context: EvaluationContext) => {
  const before = Array.map(context.before, Struct.get("rows"))
  const after = Array.map(context.after, Struct.get("rows"))
  const seenBefore = Array.isReadonlyArrayNonEmpty(before)
  const seenAfter = Array.isReadonlyArrayNonEmpty(after)
  const observed = seenBefore && seenAfter
  const unchanged = Equal.equals(before, after)
  const verdict = unchanged ? pass("Every recorded expense is unchanged after reload") : fail("The recorded expenses changed after the refused input")

  return observed ? verdict : blocked("The expenses were not observed before and after the scenario")
}

const combine = (verdicts: ReadonlyArray<Verdict>) => {
  const decisive = Array.findFirst(verdicts, Predicate.not(isPass))
  const explanations = Array.map(verdicts, Struct.get("explanation"))
  const summary = Array.join(explanations, "; ")

  return Option.getOrElse(decisive, () => pass(summary))
}

const eachRequired = (context: EvaluationContext, judgeOne: (id: string) => Verdict) => pipe(context.scenario.required, Array.map(judgeOne), combine)

const unknownEvaluator = (evaluator: string) => blocked(`Unknown evaluator ${evaluator}`)

const judge = (requirement: Requirement, context: EvaluationContext) =>
  pipe(
    Match.value(requirement.evaluator),
    Match.when("declared-outcome", () => eachRequired(context, judgeOutcome(context))),
    Match.when("recorded-echo", () => eachRequired(context, judgeEcho(context))),
    Match.when("observation-unchanged", () => judgeUnchanged(context)),
    Match.orElse(unknownEvaluator),
  )

const evaluate = (requirement: Requirement, context: EvaluationContext) => {
  const verdict = judge(requirement, context)
  const result = RequirementResult.make({ requirement: requirement.id, scenario: context.scenario.id, evaluator: requirement.evaluator, status: verdict.status, explanation: verdict.explanation, evidence: context.evidence })

  return Effect.succeed(result)
}

const service = RequirementEvaluation.of({ evaluate })

export const evaluationLayer = Layer.succeed(RequirementEvaluation, service)
