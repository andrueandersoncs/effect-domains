import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { evaluationLayer, evaluatorNames, verifyDefects } from "./evaluation.ts"
import { RequirementEvaluation, type EvaluationContext, type Payload, type Requirement } from "./model.ts"

const sentinel: Payload = { id: "018e0000-0000-7000-8000-000000000001", title: "Keep this book", author: "Fixture", status: "planned", format: "paperback", rating: null, notes: "Keep this note" }
const target: Payload = { id: "018e0000-0000-7000-8000-000000000002", title: "Change this rating", author: "Fixture", status: "reading", format: "ebook", rating: 2, notes: null }
const another: Payload = { ...sentinel, id: "018e0000-0000-7000-8000-000000000003", title: "Another book" }
const input: Payload = { title: "A new book", author: "Actual input", status: "finished", format: "hardcover", rating: 5, notes: null }
const created: Payload = { id: "018e0000-0000-7000-8000-000000000004", ...input }
const requirement = (evaluator: string): Requirement => ({
  id: "arbitrary-requirement-id", revision: "requirement-revision", provenance: "reviewed test criterion", approval: "approved",
  text: "This narrative is deliberately not an oracle.", evaluator, evaluatorRevision: "evaluator-revision", category: "behavior",
})
const createContext = (): EvaluationContext => ({
  scenario: {
    id: "scenario-id", revision: "scenario-revision", provenance: "test scenario", approval: "approved", story: "test-story",
    operation: "books.create", resource: "books", fixture: "fixture-revision", actor: "public-reader", goal: "Create a book", strategy: "maximum",
    expected: "accepted", requirements: ["arbitrary-requirement-id"], reload: true,
  },
  candidate: { input, decoded: input, source: "explicit test input", seed: 42, strategy: "maximum", valid: true, nativeValidation: "native valid", omittedFields: [] },
  before: { loaded: true, resource: "books", unfiltered: true, rows: [sentinel, another], reloaded: false },
  after: { loaded: true, resource: "books", unfiltered: true, rows: [sentinel, another, created], reloaded: true },
  sentinel, created, submission: { operation: "books.create", input, status: 200, result: created },
  evidence: ["before.json", "public-browser-submission.json", "after-reload.json"],
})
const rejectedContext = (): EvaluationContext => {
  const context = createContext()
  const rejectedInput = { ...target, rating: 6 }
  return {
    ...context, scenario: { ...context.scenario, operation: "books.update", strategy: "above", expected: "rejected" },
    candidate: { ...context.candidate, input: rejectedInput, decoded: rejectedInput, strategy: "above", valid: false, nativeValidation: "native bound violated" },
    before: { ...context.before, rows: [sentinel, target, another] },
    after: { ...context.after, rows: [another, target, sentinel] }, target,
    submission: { operation: "books.update", input: rejectedInput, status: 400, error: "Invalid input" },
  }
}

it.effect("clean and deliberately defective evidence is measured by the production evaluators", () => Effect.gen(function* () {
  const report = yield* verifyDefects()
  expect(report.summary.falseAcceptance).toBe(0)
  expect(report.summary.falseRejection).toBe(0)
  expect(report.summary.unexpectedStatuses).toBe(0)
  expect(report.summary.blocked).toBeGreaterThan(0)
  expect(report.summary.inconclusive).toBeGreaterThan(0)
  expect(report.summary.missingEvidenceControls).toBeGreaterThan(0)
  for (const control of report.cases) {
    if (control.kind === "defect") {
      expect(control.expectedFailingCriteria.length).toBeGreaterThan(0)
      for (const name of control.expectedFailingCriteria) expect(control.results.find((result) => result.evaluator === name)?.status).toBe("fail")
    }
    if (control.kind === "clean-control") expect(control.results.every((result) => result.status === "pass")).toBe(true)
    for (const result of control.results) {
      expect(result.scenario).toBe(control.observations.scenario.id)
      expect(result.evidence).toEqual(control.observations.evidence)
      expect(result.evidence.every((reference) => reference.startsWith("#/cases/"))).toBe(true)
    }
  }
  const json = JSON.parse(JSON.stringify(report))
  expect(json.summary).toEqual(report.summary)
  expect(json.cases.length).toBe(report.cases.length)
}))

for (const rating of [1, 5, null]) {
  it.effect(`accepted rating ${String(rating)} is checked on the exact update target`, () => Effect.gen(function* () {
    const service = yield* RequirementEvaluation
    const base = createContext()
    const candidate = { ...target, rating }
    const context: EvaluationContext = {
      ...base, scenario: { ...base.scenario, operation: "books.update" }, target,
      candidate: { ...base.candidate, input: candidate, decoded: candidate },
      before: { ...base.before, rows: [sentinel, target, another] }, after: { ...base.after, rows: [another, candidate, sentinel] },
      submission: { operation: "books.update", input: candidate, status: 200, result: candidate },
    }
    expect((yield* service.evaluate(requirement("accepted-rating"), context)).status).toBe("pass")
    const wrong = { ...context, after: { ...context.after, rows: [sentinel, { ...target, rating: rating === 1 ? 5 : 1 }, { ...another, rating }] } }
    expect((yield* service.evaluate(requirement("accepted-rating"), wrong)).status).toBe("fail")
  }).pipe(Effect.provide(evaluationLayer)))
}

it.effect("creation cannot pass by matching display values on an existing identity or trusting a success response", () => Effect.gen(function* () {
  const service = yield* RequirementEvaluation
  const context = createContext()
  const unchanged = { ...context, after: { ...context.after, rows: context.before.rows } }
  const overwritten = { ...context, after: { ...context.after, rows: [sentinel, { ...input, id: another.id }] } }
  const duplicate = { ...context, after: { ...context.after, rows: [...context.after.rows, { ...created }] } }
  for (const control of [unchanged, overwritten]) expect((yield* service.evaluate(requirement("created-values"), control)).status).toBe("fail")
  expect((yield* service.evaluate(requirement("created-values"), duplicate)).status).toBe("inconclusive")
}).pipe(Effect.provide(evaluationLayer)))

it.effect("rejection compares every field of every identity regardless of ordering", () => Effect.gen(function* () {
  const service = yield* RequirementEvaluation
  const context = rejectedContext()
  expect((yield* service.evaluate(requirement("rejection-unchanged"), context)).status).toBe("pass")
  const changedOther = { ...context, after: { ...context.after, rows: [sentinel, target, { ...another, notes: "Wrong" }] } }
  const deletedOther = { ...context, after: { ...context.after, rows: [sentinel, target] } }
  const added = { ...context, after: { ...context.after, rows: [...context.after.rows, created] } }
  for (const control of [changedOther, deletedOther, added]) {
    expect((yield* service.evaluate(requirement("rejection-unchanged"), control)).status).toBe("fail")
    expect((yield* service.evaluate(requirement("sentinel-unchanged"), control)).status).toBe("pass")
  }
}).pipe(Effect.provide(evaluationLayer)))

it.effect("an internal error with unchanged rows is not application rejection evidence", () => Effect.gen(function* () {
  const service = yield* RequirementEvaluation
  const context = rejectedContext()
  const response = { ...context.submission!, status: 500, error: "Internal server error" }
  expect((yield* service.evaluate(requirement("rejection-unchanged"), { ...context, submission: response })).status).toBe("inconclusive")
}).pipe(Effect.provide(evaluationLayer)))

it.effect("missing, filtered and unloaded views never pass any criterion", () => Effect.gen(function* () {
  const service = yield* RequirementEvaluation
  const context = createContext()
  for (const after of [
    { ...context.after, loaded: false, rows: [] },
    { ...context.after, unfiltered: false },
    { ...context.after, resource: "wrong-resource" },
  ]) {
    for (const name of evaluatorNames) expect((yield* service.evaluate(requirement(name), { ...context, after })).status).toBe("inconclusive")
  }
}).pipe(Effect.provide(evaluationLayer)))

it.effect("a sentinel failure does not override independent successful creation assertions", () => Effect.gen(function* () {
  const service = yield* RequirementEvaluation
  const context = createContext()
  const changed = { ...context, after: { ...context.after, rows: [{ ...sentinel, rating: 1 }, another, created] } }
  expect((yield* service.evaluate(requirement("created-values"), changed)).status).toBe("pass")
  expect((yield* service.evaluate(requirement("accepted-rating"), changed)).status).toBe("pass")
  expect((yield* service.evaluate(requirement("sentinel-unchanged"), changed)).status).toBe("fail")
}).pipe(Effect.provide(evaluationLayer)))

it.effect("interruption is blocked only before submission; missing evidence stays inconclusive", () => Effect.gen(function* () {
  const service = yield* RequirementEvaluation
  const context = createContext()
  for (const name of ["created-values", "reload-visible", "accepted-rating", "sentinel-unchanged"]) {
    expect((yield* service.evaluate(requirement(name), { ...context, submission: undefined, interruption: "No available submit action" })).status).toBe("blocked")
    expect((yield* service.evaluate(requirement(name), { ...context, submission: undefined })).status).toBe("inconclusive")
    expect((yield* service.evaluate(requirement(name), { ...context, interruption: "Model unavailable after observed submission" })).status).toBe("pass")
  }
}).pipe(Effect.provide(evaluationLayer)))

it.effect("reload binds the captured pre-reload identity rather than accepting a replacement with identical values", () => Effect.gen(function* () {
  const service = yield* RequirementEvaluation
  const context = createContext()
  const replacement = { ...context, after: { ...context.after, rows: [sentinel, another, { ...created, id: "replacement" }] } }
  expect((yield* service.evaluate(requirement("reload-visible"), replacement)).status).toBe("fail")
  expect((yield* service.evaluate(requirement("reload-visible"), { ...context, created: undefined })).status).toBe("inconclusive")
  expect((yield* service.evaluate(requirement("created-values"), { ...context, created: undefined })).status).toBe("pass")
}).pipe(Effect.provide(evaluationLayer)))

it.effect("native optional create fields use compiled nullable defaults and wrong defaults fail independently", () => Effect.gen(function* () {
  const service = yield* RequirementEvaluation
  const base = createContext()
  const omittedInput: Payload = { title: input.title, author: input.author, status: input.status, format: input.format }
  const defaulted = { ...omittedInput, id: "defaulted-created", rating: null, notes: null }
  const context: EvaluationContext = {
    ...base, created: defaulted, scenario: { ...base.scenario, strategy: "omitted" },
    candidate: { ...base.candidate, input: omittedInput, decoded: omittedInput, strategy: "omitted", omittedFields: ["rating", "notes"] },
    submission: { operation: "books.create", input: omittedInput, status: 200, result: defaulted },
    after: { ...base.after, rows: [sentinel, another, defaulted] },
  }
  for (const name of ["created-values", "reload-visible", "accepted-rating"]) {
    expect((yield* service.evaluate(requirement(name), context)).status).toBe("pass")
    const wrong = { ...context, after: { ...context.after, rows: [sentinel, another, { ...defaulted, rating: 1 }] } }
    expect((yield* service.evaluate(requirement(name), wrong)).status).toBe("fail")
    const missing = { ...context, after: { ...context.after, rows: [sentinel, another, { ...omittedInput, id: defaulted.id }] } }
    expect((yield* service.evaluate(requirement(name), missing)).status).toBe("fail")
  }
  const invalidInput = { ...omittedInput, status: "invented-status" }
  const invalid = {
    ...context, candidate: { ...context.candidate, input: invalidInput },
    submission: { ...context.submission!, input: invalidInput },
  }
  expect((yield* service.evaluate(requirement("created-values"), invalid)).status).toBe("blocked")
}).pipe(Effect.provide(evaluationLayer)))
