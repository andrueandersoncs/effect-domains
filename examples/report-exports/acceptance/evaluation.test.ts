import { expect, it } from "@effect/vitest"
import { Array, Effect, Function, Option, Schema, Struct, String as Text, pipe } from "effect"
import { BoundRequirement, Catalog, EvaluationContext, PreparedFixture, RequirementEvaluation, type Scenario } from "@effect-domains/acceptance/model"
import { reportExportsCatalog } from "./catalog.ts"
import { evaluationLayer, evaluatorRevisions, verifyDefects } from "./evaluation.ts"

type Outcome = Effect.Success<ReturnType<typeof verifyDefects>>["completion"][number]

const statusOf = (outcome: Outcome) => pipe(outcome.results, Array.map(Struct.get("status")))

const outcomeNamed = (id: string) => (outcome: Outcome) => Text.includes(id)(outcome.id)

const verifierTest = Effect.gen(function* () {
  const report = yield* verifyDefects()
  const ids = Array.map(report.completion, Struct.get("id"))
  const statuses = Array.map(report.completion, statusOf)
  const expected = Array.map(report.completion, Struct.get("expected"))
  const evaluators = pipe(report.completion, Array.flatMap(Struct.get("results")), Array.map(Struct.get("evaluator")), Array.dedupe)
  const clean = yield* pipe(report.completion, Array.findFirst(outcomeNamed("clean")), Effect.fromOption)
  const deadline = yield* pipe(report.completion, Array.findFirst(outcomeNamed("deadline")), Effect.fromOption)
  const cleanExplanation = pipe(clean.results, Array.map(Struct.get("explanation")), Array.join(" "))
  const deadlineExplanation = pipe(deadline.results, Array.map(Struct.get("explanation")), Array.join(" "))

  expect(ids).toEqual(["clean-completion", "deadline-expired", "failed-terminal", "status-regression", "hash-mismatch"])
  expect(statuses).toEqual([["pass"], ["inconclusive"], ["fail"], ["fail"], ["fail"]])
  expect(expected).toEqual(["pass", "inconclusive", "fail", "fail", "fail"])
  expect(evaluators).toEqual(["eventual-completion"])
  expect(cleanExplanation).toContain("Undiscovered → Pending accepted → Pending dispatched → Pending writing → Succeeded")
  expect(deadlineExplanation).toContain("last observed status: Pending dispatched")
  expect(report.summary.falseAcceptance).toBe(0)
  expect(report.summary.falseRejection).toBe(0)
  expect(report.summary.unexpectedStatuses).toBe(0)
  expect(report.summary.cases).toBeGreaterThan(5)
  expect(report.evaluators).toEqual(evaluatorRevisions)
})

it.effect("the eventual-completion controls pass a clean run, leave a deadline expiry inconclusive, fail Failed, regression, and hash mismatch, with zero false verdicts", Function.constant(verifierTest))

const decodeCatalog = Schema.decodeUnknownEffect(Catalog)

const isCompletionScenario = (scenario: Scenario) => Text.includes("completes")(scenario.id)

const fixture = PreparedFixture.make({ binding: "test", revision: "test", url: "about:blank", actor: "test", facts: { "tenant.id": "acme" }, tracked: ["acme"] })

const unwatched = (interruption: Option.Option<string>) => (scenario: Scenario) => EvaluationContext.make({
  scenario,
  fixture,
  candidates: [],
  submissions: [],
  before: [],
  after: [],
  probes: [],
  directProbe: Option.none(),
  barrier: Option.none(),
  watch: Option.none(),
  interruption,
  evidence: [],
})

const bound = (evaluator: string, revision: string) => BoundRequirement.make({ reference: "RE-TEST", id: "RE-TEST", revision: "1", text: "test requirement", category: "behavior", evaluator, evaluatorRevision: revision })

const completion = bound("eventual-completion", "1")
const staleCompletion = bound("eventual-completion", "2")
const declaredOutcome = bound("declared-outcome", "1")
const unknownEvaluator = bound("not-an-evaluator", "1")
const noInterruption = Option.none<string>()
const laneFailure = Option.some("lane editor failed")

const dispatchTest = Effect.gen(function* () {
  const evaluation = yield* RequirementEvaluation
  const catalog = yield* decodeCatalog(reportExportsCatalog)
  const scenario = yield* pipe(catalog.scenarios, Array.findFirst(isCompletionScenario), Effect.fromOption)
  const quiet = unwatched(noInterruption)(scenario)
  const interrupted = unwatched(laneFailure)(scenario)
  const unobserved = yield* evaluation.evaluate(completion, quiet)
  const interruptedResult = yield* evaluation.evaluate(completion, interrupted)
  const roundTrip = yield* evaluation.evaluate(declaredOutcome, quiet)
  const stale = yield* pipe(evaluation.evaluate(staleCompletion, quiet), Effect.flip)
  const unknown = yield* pipe(evaluation.evaluate(unknownEvaluator, quiet), Effect.flip)

  expect(unobserved.status).toBe("inconclusive")
  expect(unobserved.basis).toBe("executable assertion")
  expect(unobserved.explanation).toContain("no watch was recorded")
  expect(interruptedResult.status).toBe("inconclusive")
  expect(interruptedResult.explanation).toContain("lane editor failed")
  expect(roundTrip.evaluator).toBe("declared-outcome")
  expect(roundTrip.status).toBe("blocked")
  expect(stale.message).toContain("eventual-completion")
  expect(unknown.message).toContain("not-an-evaluator")
})

const dispatch = Effect.provide(dispatchTest, evaluationLayer)

it.effect("one evaluation service dispatches eventual-completion to the application evaluator and every other evaluator to the round-trip evaluators", Function.constant(dispatch))
