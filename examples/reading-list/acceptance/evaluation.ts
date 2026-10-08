import { Effect, Layer, Result, Schema } from "effect"
import { ReadingListBookSchema } from "../domain.ts"
import { ReadingListApplication } from "../application.ts"
import {
  AcceptanceError,
  RequirementEvaluation,
  PayloadSchema,
  type EvaluationContext,
  type Observation,
  type Payload,
  type Requirement,
  type RequirementResult,
  type Scenario,
} from "./model.ts"

export const evaluatorNames = [
  "created-values",
  "reload-visible",
  "accepted-rating",
  "rejection-unchanged",
  "sentinel-unchanged",
] as const

type EvaluatorName = typeof evaluatorNames[number]
type Assertion = Readonly<{ status: RequirementResult["status"]; explanation: string }>
const bookFields = Object.keys(ReadingListBookSchema.fields)
const assertion = (status: Assertion["status"], explanation: string): Assertion => ({ status, explanation })
const isEvaluatorName = (name: string): name is EvaluatorName => evaluatorNames.some((evaluator) => evaluator === name)

const equalValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length && left.every((value, index) => equalValue(value, right[index]))
  }
  // The branches above establish non-null, non-array records; compare all own JSON fields, not references.
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const keys = Object.keys(leftRecord)
  return keys.length === Object.keys(rightRecord).length
    && keys.every((key) => Object.hasOwn(rightRecord, key) && equalValue(leftRecord[key], rightRecord[key]))
}

const identity = (row: Payload): string | undefined =>
  typeof row.id === "string" && row.id.length > 0 ? row.id : undefined

const viewProblem = (view: Observation, label: string): Assertion | undefined => {
  if (!view.loaded || !view.unfiltered || view.resource !== "books") {
    return assertion("inconclusive", `${label} is not a loaded, unfiltered books observation.`)
  }
  const ids = view.rows.map(identity)
  if (ids.some((id) => id === undefined) || new Set(ids).size !== ids.length) {
    return assertion("inconclusive", `${label} has missing or duplicate stable row identities.`)
  }
  return undefined
}

const prerequisite = (context: EvaluationContext): Assertion | undefined => {
  if (context.submission === undefined) {
    return context.interruption === undefined
      ? assertion("inconclusive", "No actual browser submission response was captured.")
      : assertion("blocked", `Submission was prevented: ${context.interruption}`)
  }
  if (context.scenario.resource !== "books") return assertion("blocked", "This evaluator binds only to the books resource.")
  if (context.submission.operation !== context.scenario.operation || !equalValue(context.submission.input, context.candidate.input)) {
    return assertion("fail", "The captured submission does not match the bound operation and concrete candidate.")
  }
  return viewProblem(context.before, "Before view") ?? viewProblem(context.after, "After view") ?? fixtureProblem(context)
}

const fixtureProblem = (context: EvaluationContext): Assertion | undefined => {
  const id = identity(context.sentinel)
  if (id === undefined) return assertion("blocked", "The sentinel fixture has no stable identity.")
  const before = context.before.rows.find((row) => row.id === id)
  if (before === undefined || !equalValue(before, context.sentinel)) {
    return assertion("inconclusive", "The before view does not establish the exact seeded sentinel.")
  }
  return undefined
}

const acceptedProblem = (context: EvaluationContext): Assertion | undefined => {
  if (context.scenario.expected !== "accepted") return assertion("blocked", "This criterion requires an accepted-input scenario.")
  if (!context.candidate.valid) {
    return assertion("blocked", "The candidate was not validated for the native accepted operation path.")
  }
  const submission = context.submission!
  if (submission.status >= 400 && submission.status < 500) return assertion("fail", "The valid candidate was rejected by the application.")
  if (submission.status < 200 || submission.status >= 300) return assertion("inconclusive", "The response does not establish application acceptance or declared rejection.")
  if (submission.error !== undefined) return assertion("fail", "The acceptance response contains an application error.")
  if (submission.result === undefined) return assertion("inconclusive", "The acceptance response has no decoded operation result.")
  return undefined
}

const expectedRow = (context: EvaluationContext): Payload | Assertion => {
  if (context.scenario.operation === "books.create") {
    const beforeIds = new Set(context.before.rows.map((row) => row.id))
    const created = context.after.rows.filter((row) => !beforeIds.has(row.id))
    if (created.length !== 1) {
      return assertion("fail", `Expected one newly identified book; observed ${created.length}.`)
    }
    const row = created[0]!
    if (context.created !== undefined && row.id !== context.created.id) {
      return assertion("fail", "The new row does not match the captured created identity.")
    }
    return row
  }
  if (context.scenario.operation !== "books.update") return assertion("blocked", "Only books.create and books.update are bound to these assertions.")
  const id = context.target === undefined ? undefined : identity(context.target)
  if (id === undefined || context.candidate.input.id !== id) return assertion("blocked", "The update candidate is not bound to a stable fixture target.")
  const before = context.before.rows.find((row) => row.id === id)
  if (before === undefined || !equalValue(before, context.target)) return assertion("inconclusive", "The before view does not establish the exact update target.")
  return context.after.rows.find((row) => row.id === id)
    ?? assertion("fail", "The bound target is missing from the loaded after view.")
}

const isAssertion = (value: Payload | Assertion): value is Assertion =>
  "explanation" in value && "status" in value && !("id" in value)

const acceptedValues = (context: EvaluationContext): Assertion => {
  const problem = acceptedProblem(context)
  if (problem !== undefined) return problem
  const row = expectedRow(context)
  if (isAssertion(row)) return row
  const input = context.candidate.decoded
  if (!Schema.is(PayloadSchema)(input)) return assertion("blocked", "The native decoded candidate is not a book payload.")
  const resource = ReadingListApplication.resources.find((resource) => resource.name === "books")
  if (resource === undefined || !Schema.is(PayloadSchema)(resource.creation.defaults)) {
    return assertion("blocked", "The native compiled creation defaults are unavailable.")
  }
  const defaults = resource.creation.defaults
  const differences = bookFields.filter((field) => {
    const expected = context.scenario.operation === "books.create" && !Object.hasOwn(input, field) ? defaults[field] : input[field]
    return !Object.hasOwn(row, field) || !equalValue(row[field], expected)
  })
  return differences.length === 0
    ? assertion("pass", `Book ${String(row.id)} has every submitted domain value, including its rating.`)
    : assertion("fail", `Book ${String(row.id)} differs from the concrete candidate in: ${differences.join(", ")}.`)
}

const evaluators: Record<EvaluatorName, (context: EvaluationContext) => Assertion> = {
  "created-values": (context) => context.scenario.operation !== "books.create"
    ? assertion("blocked", "Creation values require a books.create scenario.")
    : acceptedValues(context),
  "reload-visible": (context) => {
    if (!context.after.reloaded) return assertion("inconclusive", "No actual reloaded observation was captured.")
    if (context.scenario.operation === "books.create" && (context.created === undefined || identity(context.created) === undefined)) {
      return assertion("inconclusive", "The identity created before reload was not captured.")
    }
    return acceptedValues(context)
  },
  "accepted-rating": acceptedValues,
  "rejection-unchanged": (context) => {
    if (context.scenario.expected !== "rejected") return assertion("blocked", "Rejection preservation requires a rejected-input scenario.")
    if (context.scenario.operation === "books.update") {
      const target = expectedRow({ ...context, after: context.before })
      if (isAssertion(target)) return target
    }
    const submission = context.submission!
    const afterById = new Map(context.after.rows.map((row) => [row.id, row]))
    const changed = context.before.rows.filter((row) => !equalValue(row, afterById.get(row.id)))
    if (changed.length > 0 || context.before.rows.length !== context.after.rows.length) {
      return assertion("fail", `Rejected attempt changed, removed, or added rows; changed original identities: ${changed.map((row) => String(row.id)).join(", ") || "none"}.`)
    }
    if (submission.status >= 200 && submission.status < 300 && submission.error === undefined) {
      return assertion("fail", "The invalid candidate was accepted instead of rejected.")
    }
    if (![400, 403, 422].includes(submission.status)) return assertion("inconclusive", "The response does not establish an application rejection; transport or internal errors are not rejection evidence.")
    if (submission.error === undefined && submission.result === undefined) return assertion("inconclusive", "The rejection response has no decoded evidence.")
    return assertion("pass", "The application rejected the concrete candidate and every row is exactly unchanged by stable identity.")
  },
  "sentinel-unchanged": (context) => {
    const after = context.after.rows.find((row) => row.id === context.sentinel.id)
    return equalValue(after, context.sentinel)
      ? assertion("pass", `Sentinel ${String(context.sentinel.id)} remains present with every field unchanged.`)
      : assertion("fail", `Sentinel ${String(context.sentinel.id)} was mutated or deleted.`)
  },
}

const evaluate = Effect.fn("ReadingListAcceptance.evaluate")(function* (requirement: Requirement, context: EvaluationContext) {
  if (!isEvaluatorName(requirement.evaluator)) {
    return yield* new AcceptanceError({ boundary: "requirement-evaluation", message: `Unknown evaluator: ${requirement.evaluator}` })
  }
  let result = prerequisite(context)
  let evaluatedContext = context
  if (result === undefined && context.scenario.expected === "accepted" && requirement.evaluator !== "sentinel-unchanged") {
    const operation = [...ReadingListApplication.group.requests.values()].find((operation) => operation._tag === context.scenario.operation)
    if (operation === undefined) {
      result = assertion("blocked", "The native accepted operation is unavailable.")
    } else {
      const decoded = yield* Effect.result(Schema.decodeUnknownEffect(operation.payloadSchema, { onExcessProperty: "error" })(context.candidate.input))
      if (Result.isFailure(decoded)) {
        result = assertion("blocked", `Native operation validation rejected the accepted-path candidate: ${decoded.failure.message}`)
      } else {
        evaluatedContext = { ...context, candidate: { ...context.candidate, decoded: decoded.success } }
      }
    }
  }
  result ??= evaluators[requirement.evaluator](evaluatedContext)
  return {
    requirement: requirement.id,
    requirementRevision: requirement.revision,
    scenario: context.scenario.id,
    scenarioRevision: context.scenario.revision,
    evaluator: requirement.evaluator,
    evaluatorRevision: requirement.evaluatorRevision,
    basis: "executable assertion" as const,
    ...result,
    evidence: [...context.evidence],
  } satisfies RequirementResult
})

export const evaluationLayer = Layer.succeed(RequirementEvaluation, RequirementEvaluation.of({ evaluate }))

type DefectCase = Readonly<{
  id: string
  kind: "defect" | "clean-control" | "missing-evidence-control" | "blocked-control"
  context: EvaluationContext
  expectedStatuses: Readonly<Partial<Record<EvaluatorName, RequirementResult["status"]>>>
}>

const verifierCases = (): ReadonlyArray<DefectCase> => {
  const sentinel: Payload = { id: "018e0000-0000-7000-8000-000000000001", title: "Unrelated book", author: "Fixture author", status: "planned", format: "paperback", rating: null, notes: "Preserve me" }
  const target: Payload = { id: "018e0000-0000-7000-8000-000000000002", title: "Target book", author: "Target author", status: "reading", format: "ebook", rating: 2, notes: null }
  const other: Payload = { ...sentinel, id: "018e0000-0000-7000-8000-000000000003", title: "Another unrelated book" }
  const input: Payload = { title: "Concrete submitted book", author: "Submitted author", status: "finished", format: "hardcover", rating: 5, notes: "Concrete note" }
  const created: Payload = { id: "018e0000-0000-7000-8000-000000000004", ...input }
  const view = (rows: ReadonlyArray<Payload>, reloaded = false): Observation => ({ loaded: true, unfiltered: true, resource: "books", rows, reloaded })
  const scenario = (operation: string, expected: Scenario["expected"]): Scenario => ({
    id: `verifier/${operation}/${expected}`, revision: "1", provenance: "deterministic verifier evidence control", approval: "approved",
    story: "verifier-reliability", operation, resource: "books", fixture: "verifier-fixture/1", actor: "public-reader",
    goal: "Exercise the production requirement assertions against an explicit observation control.", strategy: expected === "accepted" ? "maximum" : "above",
    expected, requirements: [], reload: true,
  })
  const create: EvaluationContext = {
    scenario: scenario("books.create", "accepted"),
    candidate: { input, decoded: input, source: "explicit verifier evidence control", seed: 0, strategy: "maximum", valid: true, nativeValidation: "native valid control", omittedFields: [] },
    before: view([sentinel, other]), after: view([sentinel, other, created], true), sentinel, created,
    submission: { operation: "books.create", input, status: 200, result: created }, evidence: ["verifier/before.json", "verifier/submission.json", "verifier/after-reload.json"],
  }
  const updateInput = { ...target, rating: 5 }
  const update: EvaluationContext = {
    ...create, scenario: scenario("books.update", "accepted"), target,
    candidate: { ...create.candidate, input: updateInput, decoded: updateInput },
    before: view([sentinel, target, other]), after: view([sentinel, updateInput, other], true),
    submission: { operation: "books.update", input: updateInput, status: 200, result: updateInput },
  }
  const rejectedInput = { ...target, rating: 6 }
  const rejected: EvaluationContext = {
    ...update, scenario: scenario("books.update", "rejected"),
    candidate: { ...update.candidate, input: rejectedInput, decoded: rejectedInput, valid: false, strategy: "above", nativeValidation: "explicit out-of-contract evidence control" },
    after: view(update.before.rows, true), submission: { operation: "books.update", input: rejectedInput, status: 400, error: "Invalid input for books.update" },
  }
  const omittedInput: Payload = { title: input.title, author: input.author, status: input.status, format: input.format }
  const omittedCreated = { ...omittedInput, id: "omitted-created-identity", rating: null, notes: null }
  const omitted: EvaluationContext = {
    ...create, created: omittedCreated, scenario: { ...scenario("books.create", "accepted"), strategy: "omitted" },
    candidate: { ...create.candidate, input: omittedInput, decoded: omittedInput, valid: true, strategy: "omitted", nativeValidation: "native operation accepts implicit nullable defaults", omittedFields: ["rating", "notes"] },
    after: view([...create.before.rows, omittedCreated], true), submission: { operation: "books.create", input: omittedInput, status: 200, result: omittedCreated },
  }
  const createPass = { "created-values": "pass", "reload-visible": "pass", "accepted-rating": "pass", "sentinel-unchanged": "pass" } as const
  const updatePass = { "reload-visible": "pass", "accepted-rating": "pass", "sentinel-unchanged": "pass" } as const
  const rejectedPass = { "rejection-unchanged": "pass", "sentinel-unchanged": "pass" } as const
  const absent = { "created-values": "fail", "reload-visible": "fail", "accepted-rating": "fail", "sentinel-unchanged": "pass" } as const
  const incomplete = { "created-values": "inconclusive", "reload-visible": "inconclusive", "accepted-rating": "inconclusive", "sentinel-unchanged": "inconclusive" } as const
  return [
    { id: "clean-create", kind: "clean-control", context: create, expectedStatuses: createPass },
    { id: "clean-update", kind: "clean-control", context: update, expectedStatuses: updatePass },
    { id: "clean-rejection", kind: "clean-control", context: rejected, expectedStatuses: rejectedPass },
    { id: "clean-omitted-create", kind: "clean-control", context: omitted, expectedStatuses: createPass },
    { id: "wrong-omitted-defaults", kind: "defect", context: { ...omitted, after: view([...create.before.rows, { ...omittedCreated, rating: 1, notes: "Incorrect default" }], true) }, expectedStatuses: absent },
    { id: "success-without-write", kind: "defect", context: { ...create, after: view(create.before.rows, true) }, expectedStatuses: absent },
    { id: "lost-after-reload", kind: "defect", context: { ...update, after: view(update.before.rows, true) }, expectedStatuses: { ...updatePass, "reload-visible": "fail", "accepted-rating": "fail" } },
    { id: "replaced-created-identity", kind: "defect", context: { ...create, after: view([sentinel, other, { ...created, id: "018e0000-0000-7000-8000-000000000005" }], true) }, expectedStatuses: absent },
    { id: "wrong-target", kind: "defect", context: { ...update, after: view([sentinel, target, { ...other, rating: 5 }], true) }, expectedStatuses: { ...updatePass, "reload-visible": "fail", "accepted-rating": "fail" } },
    { id: "unrelated-mutation", kind: "defect", context: { ...create, after: view([{ ...sentinel, notes: "Corrupted" }, other, created], true) }, expectedStatuses: { ...createPass, "sentinel-unchanged": "fail" } },
    { id: "unrelated-deletion", kind: "defect", context: { ...create, after: view([other, created], true) }, expectedStatuses: { ...createPass, "sentinel-unchanged": "fail" } },
    { id: "rejected-target-mutation", kind: "defect", context: { ...rejected, after: view([sentinel, rejectedInput, other], true) }, expectedStatuses: { ...rejectedPass, "rejection-unchanged": "fail" } },
    { id: "rejected-unrelated-mutation", kind: "defect", context: { ...rejected, after: view([sentinel, target, { ...other, notes: "Changed" }], true) }, expectedStatuses: { ...rejectedPass, "rejection-unchanged": "fail" } },
    { id: "rejected-unrelated-deletion", kind: "defect", context: { ...rejected, after: view([sentinel, target], true) }, expectedStatuses: { ...rejectedPass, "rejection-unchanged": "fail" } },
    { id: "rejected-extra-row", kind: "defect", context: { ...rejected, after: view([...rejected.before.rows, created], true) }, expectedStatuses: { ...rejectedPass, "rejection-unchanged": "fail" } },
    { id: "missing-loaded-view", kind: "missing-evidence-control", context: { ...create, after: { ...create.after, loaded: false, rows: [] } }, expectedStatuses: incomplete },
    { id: "filtered-view", kind: "missing-evidence-control", context: { ...create, after: { ...create.after, unfiltered: false } }, expectedStatuses: incomplete },
    { id: "wrong-resource-view", kind: "missing-evidence-control", context: { ...create, after: { ...create.after, resource: "another-resource" } }, expectedStatuses: incomplete },
    { id: "missing-before-view", kind: "missing-evidence-control", context: { ...create, before: { ...create.before, loaded: false } }, expectedStatuses: incomplete },
    { id: "missing-sentinel-baseline", kind: "missing-evidence-control", context: { ...create, before: view([other]) }, expectedStatuses: incomplete },
    { id: "missing-submission", kind: "missing-evidence-control", context: { ...create, submission: undefined }, expectedStatuses: incomplete },
    { id: "missing-reload", kind: "missing-evidence-control", context: { ...create, after: { ...create.after, reloaded: false } }, expectedStatuses: { ...createPass, "reload-visible": "inconclusive" } },
    { id: "missing-created-identity", kind: "missing-evidence-control", context: { ...create, created: undefined }, expectedStatuses: { ...createPass, "reload-visible": "inconclusive" } },
    { id: "interrupted-before-submission", kind: "blocked-control", context: { ...create, submission: undefined, interruption: "No enabled submit action" }, expectedStatuses: { "created-values": "blocked", "reload-visible": "blocked", "accepted-rating": "blocked", "sentinel-unchanged": "blocked" } },
  ]
}

export const verifyDefects = Effect.fn("ReadingListAcceptance.verifyDefects")(function* () {
  const service = yield* RequirementEvaluation
  const cases = yield* Effect.forEach(verifierCases(), Effect.fn("ReadingListAcceptance.verifyDefect")(function* (control: DefectCase, index: number) {
    const context: EvaluationContext = {
      ...control.context,
      scenario: { ...control.context.scenario, id: `verifier/${control.id}` },
      evidence: [
        `#/cases/${index}/observations/before`, `#/cases/${index}/observations/after`, `#/cases/${index}/observations/candidate`,
        ...(control.context.submission === undefined ? [] : [`#/cases/${index}/observations/submission`]),
      ],
    }
    const results = yield* Effect.forEach(Object.entries(control.expectedStatuses), ([name]) => service.evaluate({
      id: `verifier-criterion/${name}`, revision: "1", provenance: "reviewable deterministic verifier control", approval: "approved",
      text: `Verify ${name} against the supplied concrete evidence.`, evaluator: name, evaluatorRevision: "1",
      category: name === "sentinel-unchanged" || name === "rejection-unchanged" ? "preservation" : "behavior",
    }, context))
    const expected = (result: RequirementResult) => isEvaluatorName(result.evaluator) ? control.expectedStatuses[result.evaluator] : undefined
    return {
      id: control.id, kind: control.kind, expectedFailingCriteria: Object.entries(control.expectedStatuses).filter(([, status]) => status === "fail").map(([name]) => name),
      expectedStatuses: control.expectedStatuses, observations: context, results,
      falseAcceptance: results.filter((result) => expected(result) !== "pass" && result.status === "pass").length,
      falseRejection: results.filter((result) => expected(result) === "pass" && result.status === "fail").length,
      unexpectedStatuses: results.filter((result) => expected(result) !== result.status).length,
      blocked: results.filter((result) => result.status === "blocked").length,
      inconclusive: results.filter((result) => result.status === "inconclusive").length,
    }
  }))
  const sum = (key: "falseAcceptance" | "falseRejection" | "unexpectedStatuses" | "blocked" | "inconclusive") => cases.reduce((total, control) => total + control[key], 0)
  return {
    revision: "1", basis: "executable assertion" as const, evidenceSource: "deliberately constructed observation controls; not browser or model execution",
    cases,
    summary: {
      cases: cases.length, criteria: cases.reduce((total, control) => total + control.results.length, 0),
      falseAcceptance: sum("falseAcceptance"), falseRejection: sum("falseRejection"), unexpectedStatuses: sum("unexpectedStatuses"),
      blocked: sum("blocked"), inconclusive: sum("inconclusive"),
      missingEvidenceControls: cases.filter((control) => control.kind === "missing-evidence-control").length,
    },
  }
}, Effect.provide(evaluationLayer))
