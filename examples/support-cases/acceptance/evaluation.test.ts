import { expect, it } from "@effect/vitest"
import { Array, Effect, Equal, Function, Option, Schema, pipe } from "effect"
import { EvaluationContext, Observation, PayloadSchema, PreparedFixture, ProbeRecord, Requirement, RequirementEvaluation, Scenario, Submission, type Payload } from "@effect-domains/acceptance/model"
import { VersionConflict } from "effect-domains/repository-store"
import { supportCasesCatalog } from "./catalog.ts"
import { evaluationLayer } from "./evaluation.ts"

const customerId = "acme"
const onDutyAgent = "dana"
const offDutyAgent = "omar"
const targetId = "0192a000-0000-7000-8000-000000000002"
const unrelatedId = "0192a000-0000-7000-8000-000000000003"
const at = "2026-10-10T10:00:00.000Z"
const targetCase = PayloadSchema.make({ id: targetId, customerId, subject: "Invoice totals disagree", priority: "normal", status: "triaged", assignedAgentId: null, openedAt: "2026-10-02T09:00:00.000Z", version: 2 })
const assignedTarget = PayloadSchema.make({ ...targetCase, status: "assigned", assignedAgentId: onDutyAgent, version: 3 })
const unrelatedCase = PayloadSchema.make({ id: unrelatedId, customerId, subject: "Printer queue stalls", priority: "low", status: "triaged", assignedAgentId: null, openedAt: "2026-10-01T09:00:00.000Z", version: 2 })
const customers = [PayloadSchema.make({ id: customerId, name: "Acme Industries" })]
const agents = [PayloadSchema.make({ id: onDutyAgent, name: "Dana Ortiz", onDuty: true }), PayloadSchema.make({ id: offDutyAgent, name: "Omar Haddad", onDuty: false })]

const event = (id: string, caseId: string, kind: string, occurredAt: string) => PayloadSchema.make({ id, caseId, kind, agentId: null, note: null, occurredAt })

const events = [
  event("0192a000-0000-7000-8000-000000000101", unrelatedId, "opened", "2026-10-01T09:00:00.000Z"),
  event("0192a000-0000-7000-8000-000000000201", targetId, "opened", "2026-10-02T09:00:00.000Z"),
  event("0192a000-0000-7000-8000-000000000202", targetId, "triaged", "2026-10-02T09:05:00.000Z"),
]

const auditRow = (caseId: string, version: number, action: string) => PayloadSchema.make({ id: `support-case:${caseId}:${version}`, occurredAt: at, action, outcome: "succeeded", actorId: "public-api", targetId: caseId, traceId: null })
const targetAudit = [auditRow(targetId, 1, "open"), auditRow(targetId, 2, "triage")]
const unrelatedAudit = [auditRow(unrelatedId, 1, "open"), auditRow(unrelatedId, 2, "triage")]

const view = (resource: string, rows: ReadonlyArray<Payload>) => Observation.make({ operation: `${resource}.list`, resource, loaded: true, unfiltered: true, complete: true, rows, reloaded: true, screenshot: Option.none() })

const views = (cases: ReadonlyArray<Payload>) => [
  view("support_cases", cases),
  view("support_case_events", events),
  view("support_agents", agents),
  view("support_customers", customers),
]

const auditProbe = (phase: string, subject: string, records: ReadonlyArray<Payload>) => ProbeRecord.make({ probe: "audit-trail", phase, subject, actor: "fixture-admin-probe", at, status: 200, result: Option.some(records), error: Option.none() })

const probes = [
  auditProbe("before", targetId, targetAudit),
  auditProbe("after", targetId, targetAudit),
  auditProbe("before", unrelatedId, unrelatedAudit),
  auditProbe("after", unrelatedId, unrelatedAudit),
]

const staleInput = PayloadSchema.make({ caseId: targetId, expectedVersion: 1, action: "assign", assignedAgentId: onDutyAgent })
const conflict = VersionConflict.make({ resource: "support_cases", key: targetId, expectedVersion: 1 })
const staleSubmission = Submission.make({ inputCase: "stale-assign", operation: "support.advanceCase", input: staleInput, status: 422, result: Option.none(), error: Option.some(conflict), at })
const fixture = PreparedFixture.make({ binding: "support-target-triaged", url: "http://127.0.0.1:0", actor: "public-operator", facts: { "customer.id": customerId, "target.id": targetId, "target.version": 2 }, tracked: [targetId, unrelatedId] })
const decodeScenario = Schema.decodeUnknownEffect(Scenario)
const isStale = (scenario: typeof Scenario.Encoded) => Equal.equals(scenario.id, "stale-version-denied")

const staleContext = Effect.gen(function* () {
  const declared = yield* pipe(supportCasesCatalog.scenarios, Array.findFirst(isStale), Effect.fromOption)
  const scenario = yield* decodeScenario(declared)
  const unchanged = [unrelatedCase, targetCase]

  return EvaluationContext.make({ scenario, fixture, candidates: [], submissions: [staleSubmission], before: views(unchanged), after: views(unchanged), probes, directProbes: [], interruption: Option.none(), evidence: [] })
})

const requirement = (id: string, evaluator: string) => Requirement.make({ id, text: "This narrative is deliberately not an oracle.", evaluator })
const denied = requirement("SC-DENY", "denied-unchanged")
const preserved = requirement("SC-PRESERVE", "unrelated-unchanged")
const unknown = requirement("SC-UNKNOWN", "not-an-evaluator")
const withServerError = (submission: Submission) => Submission.make({ ...submission, status: 500, error: Option.some("Internal server error") })

const cleanDenialTest = Effect.gen(function* () {
  const service = yield* RequirementEvaluation
  const context = yield* staleContext
  const deny = yield* service.evaluate(denied, context)
  const preserve = yield* service.evaluate(preserved, context)

  expect(deny.status).toBe("pass")
  expect(deny.requirement).toBe("SC-DENY")
  expect(deny.scenario).toBe("stale-version-denied")
  expect(preserve.status).toBe("pass")
})

const mutatedDenialTest = Effect.gen(function* () {
  const service = yield* RequirementEvaluation
  const clean = yield* staleContext
  const mutated = [unrelatedCase, assignedTarget]
  const after = views(mutated)
  const context = EvaluationContext.make({ ...clean, after })
  const deny = yield* service.evaluate(denied, context)

  expect(deny.status).toBe("fail")
})

const serverErrorTest = Effect.gen(function* () {
  const service = yield* RequirementEvaluation
  const clean = yield* staleContext
  const submissions = Array.map(clean.submissions, withServerError)
  const context = EvaluationContext.make({ ...clean, submissions })
  const result = yield* service.evaluate(denied, context)
  const unknownEvaluation = service.evaluate(unknown, clean)
  const failure = yield* Effect.flip(unknownEvaluation)

  expect(result.status).toBe("inconclusive")
  expect(failure.boundary).toBe("requirement-evaluation")
})

const provided = <A, E>(test: Effect.Effect<A, E, RequirementEvaluation>) => Effect.provide(test, evaluationLayer)

const cleanDenial = provided(cleanDenialTest)
const mutatedDenial = provided(mutatedDenialTest)
const serverError = provided(serverErrorTest)

it.effect("a declared denial that changes nothing passes denial and preservation", Function.constant(cleanDenial))
it.effect("a denial that still changes the case fails", Function.constant(mutatedDenial))
it.effect("server errors are inconclusive and unknown evaluators fail evaluation", Function.constant(serverError))
