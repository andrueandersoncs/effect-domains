import { expect, it } from "@effect/vitest"
import { Array, Effect, Equal, Function, Option, Schema } from "effect"
import { Catalog, EvaluationContext, PreparedFixture, ProbeRecord, Requirement, RequirementEvaluation, Submission, type Scenario } from "@effect-domains/acceptance/model"
import { reportExportsCatalog } from "./catalog.ts"
import { evaluationLayer } from "./evaluation.ts"

const decodeCatalog = Schema.decodeUnknownEffect(Catalog)

const fixture = PreparedFixture.make({ binding: "acme-exports", url: "about:blank", actor: "editor-session", facts: { "tenant.id": "acme" }, tracked: ["acme"] })

const request = { report: { reportId: "acme-1", currency: "USD" }, lines: [{ accountCode: "4000", amountMinor: 1 }] }

const seeded = { id: "seeded", request: { report: { reportId: "seed" }, lines: [] } }

const submission = (inputCase: string, status: number, result: Option.Option<unknown>, error: Option.Option<unknown>) => Submission.make({ inputCase, operation: "ReportExport.GenerateDiscard", input: request, status, result, error, at: "now" })

const store = (phase: string, rows: ReadonlyArray<unknown>) => ProbeRecord.make({ probe: "stored-exports", phase, subject: "acme", actor: "fixture-store-probe", at: "now", status: 200, result: Option.some(rows), error: Option.none() })

const contextOf = (scenario: Scenario, submissions: ReadonlyArray<Submission>, probes: ReadonlyArray<ProbeRecord>) => EvaluationContext.make({
  scenario,
  fixture,
  candidates: [],
  submissions,
  before: [],
  after: [],
  probes,
  directProbes: [],
  interruption: Option.none(),
  evidence: [],
})

const executionId = Option.some("exec-1")

const noValue = Option.none<unknown>()

const ForbiddenSchema = Schema.TaggedStruct("Forbidden", {})

const forbiddenError = ForbiddenSchema.make({})

const forbidden = Option.some(forbiddenError)

const accepted = submission("generate-sampled", 200, executionId, noValue)

const denied = submission("generate-as-reader", 403, noValue, forbidden)

const storedRow = { id: "exec-1", request: { ...request, tenantId: "acme" } }

const alteredRow = { id: "exec-1", request: { ...request, lines: [] } }

const before = store("before", [seeded])

/** One evaluated case: the scenario, the submissions and after-store rows it saw, the evaluator, and the expected status. */
const RowsSchema = Schema.Array(Schema.Unknown)

class Case extends Schema.Class<Case>("ReportExportsEvaluatorCase")({
  scenario: Schema.String,
  submitted: Schema.Boolean,
  after: RowsSchema,
  evaluator: Schema.String,
}) {}

const cases = [
  Case.make({ scenario: "generate-sampled-export", submitted: true, after: [seeded, storedRow], evaluator: "declared-outcome" }),
  Case.make({ scenario: "generate-sampled-export", submitted: true, after: [seeded, storedRow], evaluator: "stored-request" }),
  Case.make({ scenario: "generate-sampled-export", submitted: true, after: [seeded, alteredRow], evaluator: "stored-request" }),
  Case.make({ scenario: "generate-sampled-export", submitted: true, after: [seeded, storedRow], evaluator: "generated-excluded" }),
  Case.make({ scenario: "reader-generation-denied", submitted: true, after: [seeded], evaluator: "declared-outcome" }),
  Case.make({ scenario: "reader-generation-denied", submitted: true, after: [seeded], evaluator: "store-unchanged" }),
  Case.make({ scenario: "reader-generation-denied", submitted: true, after: [seeded, storedRow], evaluator: "store-unchanged" }),
  Case.make({ scenario: "reader-generation-denied", submitted: false, after: [seeded], evaluator: "declared-outcome" }),
]

const submissionsOf = (entry: Case) => {
  const made = Equal.equals(entry.scenario, "generate-sampled-export") ? accepted : denied

  return entry.submitted ? [made] : []
}

const scenarioNamed = (id: string) => (scenario: Scenario): boolean => Equal.equals(scenario.id, id)

const evaluated = (catalog: Catalog) => Effect.fn("ReportExportsAcceptance.test.evaluated")(function* (entry: Case) {
  const evaluation = yield* RequirementEvaluation
  const found = Array.findFirst(catalog.scenarios, scenarioNamed(entry.scenario))
  const scenario = yield* Effect.fromOption(found)
  const submissions = submissionsOf(entry)
  const after = store("after", entry.after)
  const context = contextOf(scenario, submissions, [before, after])
  const requirement = Requirement.make({ id: "RE-TEST", text: "test requirement", evaluator: entry.evaluator })
  const result = yield* evaluation.evaluate(requirement, context)

  return result.status
})

const evaluatorTest = Effect.gen(function* () {
  const catalog = yield* decodeCatalog(reportExportsCatalog)
  const statuses = yield* Effect.forEach(cases, evaluated(catalog))

  expect(statuses).toEqual(["pass", "pass", "fail", "pass", "pass", "pass", "fail", "inconclusive"])
})

const evaluators = Effect.provide(evaluatorTest, evaluationLayer)

it.effect("the plain evaluators judge outcome, the stored request, and an unchanged store", Function.constant(evaluators))
