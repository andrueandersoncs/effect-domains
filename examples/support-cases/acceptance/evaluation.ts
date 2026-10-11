import { Array, DateTime, Effect, Equal, Function, HashMap, HashSet, Layer, Number, Option, Predicate, Record, Schema, String, Struct, flow, pipe } from "effect"
import type { ParseOptions } from "effect/SchemaAST"
import { Resource } from "effect-domains/resource"
import { SupportCasesApplication } from "../application.ts"
import { SupportCaseAuditsResource } from "../audit.ts"
import { SupportCaseDetail } from "../contracts.ts"
import { AdvanceSupportCaseInputSchema, OpenSupportCaseInputSchema, SupportCaseTransitions } from "../domain.ts"
import { SupportAgentsResource, SupportCaseEventsResource, SupportCasesResource } from "../resources.ts"
import { bindLocalRequirement } from "@effect-domains/acceptance/catalog"
import { supportCasesCatalog } from "./catalog.ts"
import { AcceptanceError, AssertionBasisSchema, BarrierArrival, BarrierRecord, type BoundRequirement, Candidate, Catalog, type Concurrency, ContendedSchema, DeniedSchema, EvaluationContext, Exchange, type InputCase, type Lane, Observation, PayloadSchema, PreparedFixture, ProbeRecord, ProbeTarget, type Payload, type Requirement, RequirementEvaluation, RequirementResult, ResultStatusSchema, Scenario, Submission, type WatchRecord } from "@effect-domains/acceptance/model"

type Status = typeof ResultStatusSchema.Type
type CompiledResource = typeof SupportCasesApplication.resources[number]

class Assertion extends Schema.Class<Assertion>("Assertion")({
  status: ResultStatusSchema,
  explanation: Schema.String,
}) {}

type Verdict<A> = Effect.Effect<A, Assertion>

const failing = (explanation: string) => Assertion.make({ status: "fail", explanation })
const unsettled = (explanation: string) => Assertion.make({ status: "inconclusive", explanation })
const blocking = (explanation: string) => Assertion.make({ status: "blocked", explanation })
const passing = (explanation: string) => Assertion.make({ status: "pass", explanation })
const failUnless = (condition: boolean, assertion: Assertion): Verdict<boolean> => condition ? Effect.succeed(condition) : Effect.fail(assertion)

const present = (assertion: Assertion) => <A>(option: Option.Option<A>): Verdict<A> => {
  const failure = Effect.fail(assertion)

  return Option.match(option, { onNone: Function.constant(failure), onSome: Effect.succeed })
}

const requests = SupportCasesApplication.group.requests.values()
const operations = Array.fromIterable(requests)

type Operation = typeof operations[number]

const operationEntry = (operation: Operation): readonly [string, Operation] => [operation._tag, operation]
const operationsByTag = pipe(operations, Array.map(operationEntry), HashMap.fromIterable)
const exactPayload: ParseOptions = { onExcessProperty: "error" }
const successDecoder = (value: unknown) => (operation: Operation) => Schema.decodeUnknownOption(operation.successSchema)(value)
const payloadDecoder = (value: unknown) => (operation: Operation) => Schema.decodeUnknownOption(operation.payloadSchema, exactPayload)(value)
const nativeSuccess = (tag: string) => (value: unknown) => pipe(operationsByTag, HashMap.get(tag), Option.flatMap(successDecoder(value)))
const nativePayload = (tag: string) => (value: unknown) => pipe(operationsByTag, HashMap.get(tag), Option.flatMap(payloadDecoder(value)))
const nativeAs = <A>(tag: string, guard: Predicate.Refinement<unknown, A>) => flow(nativeSuccess(tag), Option.filter(guard))
const inputAs = <A>(tag: string, guard: Predicate.Refinement<unknown, A>) => flow(nativePayload(tag), Option.filter(guard))
const casesTable = Resource.table(SupportCasesResource)
const eventsTable = Resource.table(SupportCaseEventsResource)
const agentsTable = Resource.table(SupportAgentsResource)
const auditsTable = Resource.table(SupportCaseAuditsResource)
const CaseRowsSchema = Schema.Array(casesTable.rowSchema)
const EventRowsSchema = Schema.Array(eventsTable.rowSchema)
const AgentRowsSchema = Schema.Array(agentsTable.rowSchema)
const AuditRowsSchema = Schema.Array(auditsTable.rowSchema)

type CaseRow = typeof casesTable.rowSchema.Type
type EventRow = typeof eventsTable.rowSchema.Type
type AgentRow = typeof agentsTable.rowSchema.Type

const CasesPageSchema = Schema.Struct({ items: CaseRowsSchema })

interface CasesPage extends Schema.Schema.Type<typeof CasesPageSchema> {}

const EventsPageSchema = Schema.Struct({ items: EventRowsSchema })

interface EventsPage extends Schema.Schema.Type<typeof EventsPageSchema> {}

const AgentsPageSchema = Schema.Struct({ items: AgentRowsSchema })

interface AgentsPage extends Schema.Schema.Type<typeof AgentsPageSchema> {}

interface Page<A> {
  readonly items: ReadonlyArray<A>
}

const isCasesPage: Predicate.Refinement<unknown, CasesPage> = Schema.is(CasesPageSchema)
const isEventsPage: Predicate.Refinement<unknown, EventsPage> = Schema.is(EventsPageSchema)
const isAgentsPage: Predicate.Refinement<unknown, AgentsPage> = Schema.is(AgentsPageSchema)
const pageOf = (rows: ReadonlyArray<Payload>) => PayloadSchema.make({ items: rows, nextCursor: null })
const listItems = <A>(operation: string, guard: Predicate.Refinement<unknown, Page<A>>) => flow(pageOf, nativeAs(operation, guard), Option.map(Struct.get("items")))
const decodeCases = listItems("support_cases.list", isCasesPage)
const decodeEvents = listItems("support_case_events.list", isEventsPage)
const decodeAgents = listItems("support_agents.list", isAgentsPage)
const decodeCase = flow(Array.of<Payload>, decodeCases, Option.flatMap(Array.head))
const decodeOpen = inputAs("support.openCase", Schema.is(OpenSupportCaseInputSchema))
const decodeAdvance = inputAs("support.advanceCase", Schema.is(AdvanceSupportCaseInputSchema))
const caseResult = (tag: string) => nativeAs(tag, Schema.is(casesTable.rowSchema))
const detailResult = nativeAs("support.caseDetail", Schema.is(SupportCaseDetail))
const auditResult = nativeAs("support.auditTrail", Schema.is(AuditRowsSchema))
const isPayload = Schema.is(PayloadSchema)
const isDenied = Schema.is(DeniedSchema)
const isContended = Schema.is(ContendedSchema)
const emptyPayload = PayloadSchema.make({})
const isSupportCases = (resource: CompiledResource) => Equal.equals(resource.name, "support_cases")

const creationDefaults = pipe(
  SupportCasesApplication.resources,
  Array.findFirst(isSupportCases),
  Option.map(flow(Struct.get("creation"), Struct.get("defaults"))),
  Option.filter(isPayload),
  Option.getOrElse(Function.constant(emptyPayload)),
)

// The approved requirement meaning names the history event kind of each lifecycle action because the native contract does not derive it.
const eventKinds = HashMap.make(["open", "opened"], ["triage", "triaged"], ["assign", "assigned"], ["resolve", "resolved"], ["reopen", "reopened"])
const unknownKind = Function.constant("unknown")
const kindOf = (action: string) => pipe(eventKinds, HashMap.get(action), Option.getOrElse(unknownKind))
const auditActor = "public-api"
const auditOutcome = "succeeded"
const auditId = (caseId: string, version: number) => `support-case:${caseId}:${version}`
const withinSuccess = Number.between({ minimum: 200, maximum: 299 })
const ErrorTagSchema = Schema.Struct({ _tag: Schema.String })

interface ErrorTag extends Schema.Schema.Type<typeof ErrorTagSchema> {}

const isTagged: Predicate.Refinement<unknown, ErrorTag> = Schema.is(ErrorTagSchema)
const errorTag = (submission: Submission) => pipe(submission.error, Option.filter(isTagged), Option.map(Struct.get("_tag")))
const identity = (row: Payload) => pipe(row, Record.get("id"), Option.filter(Predicate.isString), Option.filter(String.isNonEmpty))
const byIdentity = (id: string) => flow(identity, Option.contains(id))

const fieldEquals = <K extends string>(field: K, value: unknown) => <A extends Readonly<Record<K, unknown>>>(item: A) => {
  const actual: unknown = item[field]

  return Equal.equals(actual, value)
}

const byInputCase = (id: string) => fieldEquals("inputCase", id)
const byId = (id: string) => fieldEquals("id", id)
const byResource = (resource: string) => fieldEquals("resource", resource)
const deniedLabel = (failure: string) => `denied ${failure}`
const unknownOutcome = Function.constant("unknown")
const listed = (fields: ReadonlyArray<string>) => Array.join(fields, ", ")

const observedOutcome = (submission: Submission) => {
  const tag = errorTag(submission)
  const untagged = Option.isNone(tag)
  const badRequest = Equal.equals(submission.status, 400)
  const rejected = badRequest && untagged
  const policy = Equal.equals(submission.status, 422)
  const denial = Option.match(tag, { onNone: unknownOutcome, onSome: deniedLabel })
  const accepted = withinSuccess(submission.status)

  if (accepted) return "accepted"

  if (policy) return denial

  return rejected ? "rejected" : "unknown"
}

const acceptedLabel = "accepted"
const outcomeList = Array.join(" or ")

const contendedLabels = (failures: ReadonlyArray<string>) => {
  const refusals = Array.map(failures, deniedLabel)

  return [acceptedLabel, ...refusals]
}

const deniedLabels = flow(deniedLabel, Array.of)

// A contended input names acceptance and every declared refusal because which competitor wins its race, and which documented refusal the loser meets, is not determined in advance.
const declaredOutcomes = (input: InputCase): ReadonlyArray<string> => {
  const { outcome } = input

  if (isDenied(outcome)) return deniedLabels(outcome.failure)

  return isContended(outcome) ? contendedLabels(outcome.failures) : Array.of(outcome.kind)
}

const undeclaredLabel = Function.constant("undeclared")

const outcomeProblem = (context: EvaluationContext) => (submission: Submission) => {
  const declared = Array.findFirst(context.scenario.inputs, byId(submission.inputCase))
  const observed = observedOutcome(submission)
  const unknown = Equal.equals(observed, "unknown")
  const expected = Option.map(declared, declaredOutcomes)
  const matches = Option.exists(expected, Array.contains(observed))
  const expectedLabel = pipe(expected, Option.map(outcomeList), Option.getOrElse(undeclaredLabel))
  const undeclared = unsettled(`Submission ${submission.inputCase} is not a declared input case of ${context.scenario.id}.`)
  const unestablished = unsettled(`Submission ${submission.inputCase} returned HTTP ${submission.status}, which establishes neither acceptance, a declared denial, nor a native rejection.`)
  const mismatched = failing(`Submission ${submission.inputCase} was ${observed} (HTTP ${submission.status}) but the input case declares ${expectedLabel}.`)

  if (Option.isNone(declared)) return Option.some(undeclared)

  if (unknown) return Option.some(unestablished)

  return matches ? Option.none<Assertion>() : Option.some(mismatched)
}

const requiredProblem = (context: EvaluationContext) => (id: string) => {
  const count = Array.countBy(context.submissions, byInputCase(id))
  const prevented = (interruption: string) => blocking(`Required input ${id} was never submitted because the run was interrupted: ${interruption}`)
  const uncapturedAssertion = unsettled(`Required input ${id} has no captured browser submission.`)
  const uncaptured = Function.constant(uncapturedAssertion)
  const missing = Option.match(context.interruption, { onNone: uncaptured, onSome: prevented })
  const repeated = unsettled(`Required input ${id} was submitted ${count} times; exactly one submission is required.`)
  const absent = Equal.equals(count, 0)
  const single = Equal.equals(count, 1)

  if (absent) return Option.some(missing)

  return single ? Option.none<Assertion>() : Option.some(repeated)
}

const observedViewProblem = (label: string, reload: boolean) => (view: Observation) => {
  const whole = Array.every([view.loaded, view.unfiltered, view.complete], Boolean)
  const ids = Array.map(view.rows, identity)
  const identified = Array.getSomes(ids)
  const distinct = HashSet.fromIterable(identified)
  const idCount = Array.length(ids)
  const identifiedCount = Array.length(identified)
  const distinctCount = HashSet.size(distinct)
  const allIdentified = Equal.equals(identifiedCount, idCount)
  const unique = Equal.equals(distinctCount, identifiedCount)
  const identifiable = allIdentified && unique
  const stale = !view.reloaded
  const unreloaded = reload && stale
  const partial = unsettled(`The ${label} ${view.resource} view is not a loaded, unfiltered, complete list.`)
  const unidentified = unsettled(`The ${label} ${view.resource} view has missing or duplicate row identities.`)
  const notReloaded = unsettled(`The ${label} ${view.resource} view was not observed after a reload.`)

  if (!whole) return Option.some(partial)

  if (!identifiable) return Option.some(unidentified)

  return unreloaded ? Option.some(notReloaded) : Option.none<Assertion>()
}

const viewProblem = (label: string, observations: ReadonlyArray<Observation>, reload: boolean) => (resource: string) => {
  const view = Array.findFirst(observations, byResource(resource))
  const missing = unsettled(`The ${label} ${resource} view was not observed.`)
  const missingProblem = Option.some(missing)

  return Option.match(view, { onNone: Function.constant(missingProblem), onSome: observedViewProblem(label, reload) })
}

const prerequisiteProblem = (context: EvaluationContext) => {
  const required = Array.map(context.scenario.required, requiredProblem(context))
  const outcomes = Array.map(context.submissions, outcomeProblem(context))
  const before = Array.map(context.scenario.observations, viewProblem("before", context.before, false))
  const after = Array.map(context.scenario.observations, viewProblem("after", context.after, context.scenario.reload))

  return Option.firstSomeOf([...required, ...outcomes, ...before, ...after])
}

const emptyRows: ReadonlyArray<Payload> = []
const noRows = Function.constant(emptyRows)
const rowsOf = (observations: ReadonlyArray<Observation>, resource: string) => pipe(observations, Array.findFirst(byResource(resource)), Option.map(Struct.get("rows")), Option.getOrElse(noRows))
const textFact = (fact: string) => (context: EvaluationContext) => pipe(context.fixture.facts, Record.get(fact), Option.filter(Predicate.isString))

const decodedRows = <A>(label: string, decode: (rows: ReadonlyArray<Payload>) => Option.Option<A>) => {
  const undecoded = unsettled(`The observed ${label} rows do not decode with the native ${label}.list success schema.`)

  return flow(decode, present(undecoded))
}

const eventRows = decodedRows("support_case_events", decodeEvents)
const agentRows = decodedRows("support_agents", decodeAgents)

const probeMatches = (target: ProbeTarget) => (record: ProbeRecord) => {
  const probe = Equal.equals(record.probe, target.probe)
  const phase = Equal.equals(record.phase, target.phase)
  const subject = Equal.equals(record.subject, target.subject)

  return Array.every([probe, phase, subject], Boolean)
}

const succeededProbe = (record: ProbeRecord) => Equal.equals(record.status, 200)

const probeValue = (context: EvaluationContext, target: ProbeTarget) => {
  const record = Array.findFirst(context.probes, probeMatches(target))
  const succeeded = Option.filter(record, succeededProbe)
  const value = pipe(succeeded, Option.flatMap(Struct.get("result")))
  const missing = unsettled(`The ${target.probe} probe ${target.phase} for ${target.subject} is missing or did not succeed.`)

  return present(missing)(value)
}

const auditProbe = Effect.fn("SupportAcceptance.auditProbe")(function* (context: EvaluationContext, phase: string, subject: string) {
  const target = ProbeTarget.make({ probe: "audit-trail", phase, subject })
  const value = yield* probeValue(context, target)
  const undecoded = failing(`The ${phase} audit trail of ${subject} does not decode with the native support.auditTrail success schema.`)

  return yield* pipe(value, auditResult, present(undecoded))
})

const NullableTextSchema = Schema.NullOr(Schema.String)

class Step extends Schema.Class<Step>("Step")({
  inputCase: Schema.String,
  operation: Schema.String,
  action: Schema.String,
  note: NullableTextSchema,
  submittedAgent: NullableTextSchema,
  result: casesTable.rowSchema,
}) {}

const lifecycleOperations = ["support.openCase", "support.advanceCase"]
const isLifecycle = (submission: Submission) => Array.contains(lifecycleOperations, submission.operation)
const isOpenCase = fieldEquals("operation", "support.openCase")
const isAuditRead = fieldEquals("operation", "support.auditTrail")
const isAccepted = (submission: Submission) => withinSuccess(submission.status)
const acceptedLifecycle = (context: EvaluationContext) => pipe(context.submissions, Array.filter(isAccepted), Array.filter(isLifecycle))
const optionalText = (input: Payload, field: string) => pipe(input, Record.get(field), Option.filter(Predicate.isString), Option.getOrNull)
const openAction = Option.some("open")

const decodeStep = Effect.fn("SupportAcceptance.decodeStep")(function* (submission: Submission) {
  const undecoded = failing(`The ${submission.inputCase} result does not decode with the native ${submission.operation} success schema.`)
  const decodeResult = caseResult(submission.operation)
  const decoded = Option.flatMap(submission.result, decodeResult)
  const result = yield* present(undecoded)(decoded)
  const opening = isOpenCase(submission)
  const advance = decodeAdvance(submission.input)
  const advanced = pipe(advance, Option.map(Struct.get("action")))
  const action = opening ? openAction : advanced
  const invalid = failing(`The accepted ${submission.inputCase} input is not a native ${submission.operation} payload.`)
  const decodedAction = yield* present(invalid)(action)
  const note = optionalText(submission.input, "note")
  const submittedAgent = optionalText(submission.input, "assignedAgentId")

  return Step.make({ inputCase: submission.inputCase, operation: submission.operation, action: decodedAction, note, submittedAgent, result })
})

const lifecycleSteps = (context: EvaluationContext) => {
  const accepted = acceptedLifecycle(context)

  return Effect.forEach(accepted, decodeStep)
}

const isOpening = (step: Step) => Equal.equals(step.action, "open")
const isAdvance = Predicate.not(isOpening)
const resultsOf = (steps: ReadonlyArray<Step>) => pipe(steps, Array.map(Struct.get("result")))
const notOpening = blocking("This requirement needs an accepted support.openCase submission that captures the case.")
const openingOf = (steps: ReadonlyArray<Step>) => Array.findFirst(steps, isOpening)
const openedStep = flow(openingOf, present(notOpening))
const isPrepared = flow(openingOf, Option.isNone)
const stepCaseId = (step: Step) => step.result.id
const openedCase = (context: EvaluationContext) => pipe(acceptedLifecycle(context), Array.findFirst(isOpenCase), Option.flatMap(Struct.get("result")), Option.flatMap(caseResult("support.openCase")), Option.map(Struct.get("id")))
const targetFact = textFact("target.id")

const subjectCase = (context: EvaluationContext) => {
  const opened = openedCase(context)
  const target = targetFact(context)

  return Option.orElse(opened, Function.constant(target))
}

const noSubject = blocking("This requirement needs an accepted support.openCase submission that captures the case or a prepared subject case declared by the fixture fact target.id.")

const lifecycleSubject = (context: EvaluationContext, steps: ReadonlyArray<Step>) => {
  const opened = pipe(steps, openingOf, Option.map(stepCaseId))
  const prepared = targetFact(context)

  return pipe(opened, Option.orElse(Function.constant(prepared)), present(noSubject))
}

const preparedStart = (context: EvaluationContext, subject: string) => {
  const beforeCases = rowsOf(context.before, "support_cases")
  const unestablished = unsettled(`The before support_cases view does not establish prepared case ${subject} as a native support_cases row.`)

  return pipe(beforeCases, Array.findFirst(byIdentity(subject)), Option.flatMap(decodeCase), present(unestablished))
}

const startState = (context: EvaluationContext, steps: ReadonlyArray<Step>, subject: string) => {
  const opened = pipe(steps, openingOf, Option.map(Struct.get("result")))
  const prepared = preparedStart(context, subject)

  return Option.match(opened, { onNone: Function.constant(prepared), onSome: Effect.succeed })
}

const differs = (observed: Payload, expected: Payload) => (field: string) => {
  const actual = Record.get(observed, field)
  const wanted = Record.get(expected, field)

  return !Equal.equals(actual, wanted)
}

const differingFields = (observed: Payload, expected: Payload) => {
  const fields = Record.keys(expected)

  return Array.filter(fields, differs(observed, expected))
}

const notIn = (ids: HashSet.HashSet<string>) => (row: Payload) => {
  const id = identity(row)
  const known = Option.exists(id, (value) => HashSet.has(ids, value))

  return !known
}

const idsOf = (rows: ReadonlyArray<Payload>) => pipe(rows, Array.map(identity), Array.getSomes, HashSet.fromIterable)
const nothingAdded = unsettled("The new support_cases row does not decode with the native support_cases.list success schema.")
const replacedCase = failing("The new support_cases row is not the opened case.")
const invalidOpening = failing("The accepted opening input is not a native support.openCase payload.")
const missingOpening = unsettled("The opening submission is missing.")

const openedCaseEvaluator = Effect.fn("SupportAcceptance.openedCase")(function* (context: EvaluationContext) {
  const steps = yield* lifecycleSteps(context)
  const opened = yield* openedStep(steps)
  const submission = yield* pipe(context.submissions, Array.findFirst(byInputCase(opened.inputCase)), present(missingOpening))
  const input = yield* pipe(submission.input, decodeOpen, present(invalidOpening))
  const expected = PayloadSchema.make({ ...creationDefaults, ...input, version: 1 })
  const differences = differingFields(opened.result, expected)
  const differenceList = listed(differences)
  const identical = Array.isReadonlyArrayEmpty(differences)
  const different = failing(`The opened case result differs from the submitted input or compiled defaults in: ${differenceList}.`)

  yield* failUnless(identical, different)

  const beforeCases = rowsOf(context.before, "support_cases")
  const afterCases = rowsOf(context.after, "support_cases")
  const beforeIds = idsOf(beforeCases)
  const added = Array.filter(afterCases, notIn(beforeIds))
  const count = Array.length(added)
  const single = Equal.equals(count, 1)
  const only = single ? Array.head(added) : Option.none<Payload>()
  const notSingle = failing(`Expected exactly one new support_cases row; observed ${count}.`)
  const row = yield* present(notSingle)(only)
  const sameCase = byIdentity(opened.result.id)(row)

  yield* failUnless(sameCase, replacedCase)

  const decoded = yield* pipe(row, decodeCase, present(nothingAdded))
  const preserved = PayloadSchema.make({ customerId: opened.result.customerId, subject: opened.result.subject, priority: opened.result.priority, openedAt: opened.result.openedAt })
  const changed = differingFields(decoded, preserved)
  const changedList = listed(changed)
  const kept = Array.isReadonlyArrayEmpty(changed)
  const rewritten = failing(`The final case row changed opened values: ${changedList}.`)

  yield* failUnless(kept, rewritten)

  return passing(`Case ${opened.result.id} opened once as open, unassigned, version 1 with the submitted values and survives in the final view.`)
})

const onDutyWith = (id: string) => (agent: AgentRow) => {
  const same = Equal.equals(agent.id, id)

  return same && agent.onDuty
}

const isOnDuty = (agents: ReadonlyArray<AgentRow>, id: string | null) => Predicate.isNotNull(id) && Array.some(agents, onDutyWith(id))
const problemAt = (inputCase: string) => (field: string) => `${inputCase}: ${field}`

const transitionProblems = (agents: ReadonlyArray<AgentRow>) => ([prior, step]: readonly [CaseRow, Step]) => {
  const transition = Record.get(SupportCaseTransitions.transitions, step.action)
  const sources = pipe(transition, Option.map(Struct.get("from")))
  const allowedFrom = Option.exists(sources, (statuses) => Array.contains(statuses, prior.status))
  const target = pipe(transition, Option.map(Struct.get("to")), Option.getOrNull)
  const assigning = Equal.equals(step.action, "assign")
  const reopening = Equal.equals(step.action, "reopen")
  const kept = reopening ? null : prior.assignedAgentId
  const assignment = assigning ? step.submittedAgent : kept
  const version = prior.version + 1
  const expected = PayloadSchema.make({ ...prior, status: target, version, assignedAgentId: assignment })
  const changed = differingFields(step.result, expected)
  const fieldProblems = Array.map(changed, problemAt(step.inputCase))
  const available = isOnDuty(agents, step.submittedAgent)
  const unavailable = !available
  const dutyViolated = assigning && unavailable
  const sourceProblem = allowedFrom ? Option.none<string>() : Option.some(`${step.inputCase}: prior status ${prior.status} is outside the native transition source`)
  const dutyProblem = dutyViolated ? Option.some(`${step.inputCase}: assigned agent is not on duty`) : Option.none<string>()
  const policyProblems = Array.getSomes([sourceProblem, dutyProblem])

  return [...fieldProblems, ...policyProblems]
}

const noAdvances = blocking("Lifecycle transitions need at least one accepted support.advanceCase submission.")

const lifecycleEvaluator = Effect.fn("SupportAcceptance.lifecycleTransitions")(function* (context: EvaluationContext) {
  const steps = yield* lifecycleSteps(context)
  const subject = yield* lifecycleSubject(context, steps)
  const start = yield* startState(context, steps, subject)
  const advances = Array.filter(steps, isAdvance)
  const advancing = Array.isReadonlyArrayNonEmpty(advances)

  yield* failUnless(advancing, noAdvances)

  const beforeAgents = rowsOf(context.before, "support_agents")
  const agents = yield* agentRows(beforeAgents)
  const results = resultsOf(advances)
  const chain = Array.prepend(results, start)
  const pairs = Array.zip(chain, advances)
  const problems = Array.flatMap(pairs, transitionProblems(agents))
  const problemList = listed(problems)
  const consistent = Array.isReadonlyArrayEmpty(problems)
  const violation = failing(`Accepted lifecycle results violate the native transition contract: ${problemList}.`)

  yield* failUnless(consistent, violation)

  const last = Array.lastNonEmpty(chain)
  const finalCases = rowsOf(context.after, "support_cases")
  const lost = failing(`Case ${subject} is missing from the reloaded support_cases view.`)
  const observed = yield* pipe(finalCases, Array.findFirst(byIdentity(subject)), present(lost))
  const undecoded = unsettled(`The reloaded row of case ${subject} does not decode with the native support_cases.list success schema.`)
  const decoded = yield* pipe(observed, decodeCase, present(undecoded))
  const survived = Equal.equals(decoded, last)
  const diverged = failing(`The reloaded row of case ${subject} differs from the last accepted result.`)

  yield* failUnless(survived, diverged)

  return passing(`Every accepted command on case ${subject} followed the native transition graph, advanced the version by one, kept the assignment rules, and the final state survived reload.`)
})

const noneLabel = Function.constant("none")
const labelOf = (value: string | null) => pipe(value, Option.fromNullishOr, Option.getOrElse(noneLabel))

const eventKey = (kind: string, agentId: string | null, note: string | null) => {
  const agent = labelOf(agentId)
  const remark = labelOf(note)

  return `${kind}(agent=${agent}, note=${remark})`
}

const observedEventKey = (event: EventRow) => eventKey(event.kind, event.agentId, event.note)

const expectedEventKey = (step: Step) => {
  const kind = kindOf(step.action)

  return eventKey(kind, step.result.assignedAgentId, step.note)
}

const ordered = ([earlier, later]: readonly [EventRow, EventRow]) => DateTime.isLessThanOrEqualTo(earlier.occurredAt, later.occurredAt)
const ofCase = (subject: string) => (row: Payload) => pipe(row, Record.get("caseId"), Option.contains<unknown>(subject))

const subjectPriorEvents = (context: EvaluationContext, steps: ReadonlyArray<Step>, subject: string) => {
  const beforeEvents = rowsOf(context.before, "support_case_events")
  const subjectEvents = Array.filter(beforeEvents, ofCase(subject))
  const prepared = isPrepared(steps)

  return prepared ? subjectEvents : emptyRows
}

const historyEvaluator = Effect.fn("SupportAcceptance.orderedHistory")(function* (context: EvaluationContext) {
  const steps = yield* lifecycleSteps(context)
  const subject = yield* lifecycleSubject(context, steps)
  const priorRows = subjectPriorEvents(context, steps, subject)
  const prior = yield* eventRows(priorRows)
  const afterEvents = rowsOf(context.after, "support_case_events")
  const caseEvents = Array.filter(afterEvents, ofCase(subject))
  const events = yield* eventRows(caseEvents)
  const observed = Array.map(events, observedEventKey)
  const priorKeys = Array.map(prior, observedEventKey)
  const stepKeys = Array.map(steps, expectedEventKey)
  const expected = [...priorKeys, ...stepKeys]
  const observedList = listed(observed)
  const expectedList = listed(expected)
  const matches = Equal.equals(observed, expected)
  const mismatched = failing(`Case ${subject} history is [${observedList}]; expected [${expectedList}].`)

  yield* failUnless(matches, mismatched)

  const priorCount = Array.length(priorRows)
  const keptRows = Array.take(caseEvents, priorCount)
  const priorKept = Equal.equals(keptRows, priorRows)
  const rewritten = failing(`Case ${subject} history does not begin with its ${priorCount} prior events exactly as observed before the scenario.`)

  yield* failUnless(priorKept, rewritten)

  const successors = Array.drop(events, 1)
  const pairs = Array.zip(events, successors)
  const chronological = Array.every(pairs, ordered)
  const unordered = failing(`Case ${subject} history is not in non-decreasing occurrence order.`)

  yield* failUnless(chronological, unordered)

  return passing(`Case ${subject} history holds its prior events followed by exactly one ordered event per accepted command with the submitted notes and resulting agents.`)
})

const unassigned = Option.some(null)
const agentFor = (id: string | null) => (agents: ReadonlyArray<AgentRow>) => Predicate.isNull(id) ? unassigned : Array.findFirst(agents, byId(id))
const customerIdFact = textFact("customer.id")
const customerNameFact = textFact("customer.name")
const missingCustomer = blocking("The fixture does not declare customer.id and customer.name.")

const joinCheck = (context: EvaluationContext, agents: ReadonlyArray<AgentRow>, priorCount: number) => Effect.fn("SupportAcceptance.joinCheck")(function* (step: Step, index: number) {
  const target = ProbeTarget.make({ probe: "case-detail", phase: `after:${step.inputCase}`, subject: step.result.id })
  const value = yield* probeValue(context, target)
  const undecoded = failing(`The case detail after ${step.inputCase} does not decode with the native support.caseDetail success schema.`)
  const detail = yield* pipe(value, detailResult, present(undecoded))
  const customerId = yield* pipe(context, customerIdFact, present(missingCustomer))
  const customerName = yield* pipe(context, customerNameFact, present(missingCustomer))
  const unknownAgent = failing(`The agent assigned after ${step.inputCase} is not a prepared agent.`)
  const agent = yield* pipe(agents, agentFor(step.result.assignedAgentId), present(unknownAgent))
  const eventCount = Array.length(detail.events)
  const observed = PayloadSchema.make({ case: detail.case, customerId: detail.customer.id, customerName: detail.customer.name, agent: detail.agent, events: eventCount })
  const expected = PayloadSchema.make({ case: step.result, customerId, customerName, agent, events: priorCount + index + 1 })
  const differences = differingFields(observed, expected)
  const differenceList = listed(differences)
  const joined = Array.isReadonlyArrayEmpty(differences)
  const mismatched = failing(`The case detail after ${step.inputCase} differs in: ${differenceList}.`)

  return yield* failUnless(joined, mismatched)
})

const joinedEvaluator = Effect.fn("SupportAcceptance.joinedDetail")(function* (context: EvaluationContext) {
  const steps = yield* lifecycleSteps(context)
  const subject = yield* lifecycleSubject(context, steps)
  const priorRows = subjectPriorEvents(context, steps, subject)
  const priorCount = Array.length(priorRows)
  const beforeAgents = rowsOf(context.before, "support_agents")
  const agents = yield* agentRows(beforeAgents)

  yield* Effect.forEach(steps, joinCheck(context, agents, priorCount))

  return passing(`After every accepted command, case ${subject} joins its customer, its current agent, and its events so far.`)
})

type AuditRow = typeof auditsTable.rowSchema.Type

const auditKey = (record: AuditRow) => `${record.id}/${record.action}/${record.outcome}/${record.actorId}/${record.targetId}`

const expectedAuditKey = (subject: string) => (step: Step) => {
  const id = auditId(subject, step.result.version)

  return `${id}/${step.action}/${auditOutcome}/${auditActor}/${subject}`
}

const noAudit: ReadonlyArray<AuditRow> = []

const subjectPriorAudit = (context: EvaluationContext, steps: ReadonlyArray<Step>, subject: string) => {
  const prepared = isPrepared(steps)
  const recorded = auditProbe(context, "before", subject)
  const none = Effect.succeed(noAudit)

  return prepared ? recorded : none
}

const auditRecordedEvaluator = Effect.fn("SupportAcceptance.auditRecorded")(function* (context: EvaluationContext) {
  const steps = yield* lifecycleSteps(context)
  const subject = yield* lifecycleSubject(context, steps)
  const prior = yield* subjectPriorAudit(context, steps, subject)
  const records = yield* auditProbe(context, "after", subject)
  const observed = Array.map(records, auditKey)
  const priorKeys = Array.map(prior, auditKey)
  const stepKeys = Array.map(steps, expectedAuditKey(subject))
  const expected = [...priorKeys, ...stepKeys]
  const observedList = listed(observed)
  const expectedList = listed(expected)
  const matches = Equal.equals(observed, expected)
  const mismatched = failing(`Case ${subject} audit is [${observedList}]; expected [${expectedList}].`)

  yield* failUnless(matches, mismatched)

  return passing(`Every accepted command on case ${subject} appended exactly one succeeded audit record for its version after its prior audit.`)
})

const unknownIdentity = Function.constant("?")
const idLabel = flow(identity, Option.getOrElse(unknownIdentity))
const rowDescription = (resource: string, change: string) => (row: Payload) => `${resource}/${idLabel(row)} ${change}`
const neverOwned = Function.constant(false)
const valueMatcher = (value: Option.Option<unknown>) => flow(Option.some<unknown>, Equal.equals(value))

const belongsTo = (subject: Option.Option<string>, field: string) => (row: Payload) => {
  const value = Record.get(row, field)

  return Option.exists(subject, valueMatcher(value))
}

const ownedBy = (resource: string, subject: Option.Option<string>) => {
  const caseRows = Equal.equals(resource, "support_cases")
  const eventRowsOwned = Equal.equals(resource, "support_case_events")
  const field = caseRows ? "id" : "caseId"
  const tracked = caseRows || eventRowsOwned

  return tracked ? belongsTo(subject, field) : neverOwned
}

const retainedIn = (rows: ReadonlyArray<Payload>) => (row: Payload) => Array.contains(rows, row)

const permittedBy = (owned: (row: Payload) => boolean, growing: boolean) => (row: Payload) => {
  const mine = owned(row)

  return growing && mine
}

const resourceProblems = (context: EvaluationContext, subject: Option.Option<string>, growing: boolean) => (resource: string) => {
  const before = rowsOf(context.before, resource)
  const after = rowsOf(context.after, resource)
  const owned = ownedBy(resource, subject)
  const afterIds = idsOf(after)
  const beforeIds = idsOf(before)
  const deleted = Array.filter(before, notIn(afterIds))
  const changed = pipe(before, Array.filter(Predicate.not(owned)), Array.filter(Predicate.not(retainedIn(after))))
  const added = Array.filter(after, notIn(beforeIds))
  const disallowed = Array.filter(added, Predicate.not(permittedBy(owned, growing)))

  return [
    ...Array.map(deleted, rowDescription(resource, "deleted")),
    ...Array.map(changed, rowDescription(resource, "changed")),
    ...Array.map(disallowed, rowDescription(resource, "added")),
  ]
}

const auditChange = (context: EvaluationContext) => Effect.fn("SupportAcceptance.auditChange")(function* (subject: string) {
  const before = yield* auditProbe(context, "before", subject)
  const after = yield* auditProbe(context, "after", subject)
  const same = Equal.equals(before, after)

  return same ? Option.none<string>() : Option.some(`audit of ${subject} changed`)
})

const notSubject = (subject: Option.Option<string>) => (id: string) => !Option.contains(subject, id)

const unrelatedEvaluator = Effect.fn("SupportAcceptance.unrelatedUnchanged")(function* (context: EvaluationContext) {
  const subject = subjectCase(context)
  const accepted = acceptedLifecycle(context)
  const growing = Array.isReadonlyArrayNonEmpty(accepted)
  const others = Array.filter(context.fixture.tracked, notSubject(subject))
  const audits = yield* Effect.forEach(others, auditChange(context))
  const rows = Array.flatMap(context.scenario.observations, resourceProblems(context, subject, growing))
  const changes = Array.getSomes(audits)
  const problems = [...rows, ...changes]
  const problemList = listed(problems)
  const preserved = Array.isReadonlyArrayEmpty(problems)
  const changed = failing(`Records outside the scenario subject changed: ${problemList}.`)

  yield* failUnless(preserved, changed)

  return passing("Every observed row and audit trail outside the scenario subject is exactly unchanged, and nothing was deleted.")
})

const subjectUnchanged = Effect.fn("SupportAcceptance.subjectUnchanged")(function* (context: EvaluationContext, subject: string) {
  const beforeCases = rowsOf(context.before, "support_cases")
  const afterCases = rowsOf(context.after, "support_cases")
  const unestablished = unsettled(`The before view does not establish case ${subject}.`)
  const prior = yield* pipe(beforeCases, Array.findFirst(byIdentity(subject)), present(unestablished))
  const current = Array.findFirst(afterCases, byIdentity(subject))
  const kept = Option.contains(current, prior)
  const caseChanged = failing(`Case ${subject} changed or disappeared.`)

  yield* failUnless(kept, caseChanged)

  const beforeEvents = rowsOf(context.before, "support_case_events")
  const afterEvents = rowsOf(context.after, "support_case_events")
  const priorEvents = Array.filter(beforeEvents, ofCase(subject))
  const currentEvents = Array.filter(afterEvents, ofCase(subject))
  const historyKept = Equal.equals(priorEvents, currentEvents)
  const historyChanged = failing(`The history of case ${subject} changed.`)

  yield* failUnless(historyKept, historyChanged)

  const owner = Option.some(subject)
  const additions = Array.flatMap(context.scenario.observations, resourceProblems(context, owner, false))
  const additionList = listed(additions)
  const untouched = Array.isReadonlyArrayEmpty(additions)
  const recordsChanged = failing(`Observed records changed: ${additionList}.`)

  yield* failUnless(untouched, recordsChanged)

  const priorAudit = yield* auditProbe(context, "before", subject)
  const currentAudit = yield* auditProbe(context, "after", subject)
  const auditKept = Equal.equals(priorAudit, currentAudit)
  const auditChanged = failing(`The audit trail of case ${subject} changed.`)

  return yield* failUnless(auditKept, auditChanged)
})

const outcomeKind = (kind: string) => (input: InputCase) => Equal.equals(input.outcome.kind, kind)
const inputsWith = (context: EvaluationContext, kind: string) => Array.filter(context.scenario.inputs, outcomeKind(kind))
const noTarget = blocking("The fixture does not declare target.id.")
const preparedTarget = flow(targetFact, present(noTarget))
const noDenial = blocking("This requirement needs a declared denial input.")

const deniedEvaluator = Effect.fn("SupportAcceptance.deniedUnchanged")(function* (context: EvaluationContext) {
  const denials = inputsWith(context, "denied")
  const declared = Array.isReadonlyArrayNonEmpty(denials)

  yield* failUnless(declared, noDenial)

  const subject = yield* preparedTarget(context)

  yield* subjectUnchanged(context, subject)

  return passing(`The declared denial was observed and case ${subject}, its history, and its audit trail are unchanged.`)
})

const invalidCandidate = (context: EvaluationContext) => Effect.fn("SupportAcceptance.invalidCandidate")(function* (input: InputCase) {
  const noCandidate = blocking(`No candidate was offered for ${input.id}.`)
  const candidate = yield* pipe(context.candidates, Array.findFirst(byInputCase(input.id)), present(noCandidate))
  const invalid = Equal.equals(candidate.validity, "native-invalid")
  const notInvalid = blocking(`Candidate ${input.id} was not prepared as native-invalid input.`)

  yield* failUnless(invalid, notInvalid)

  const unsubmitted = unsettled(`Input ${input.id} was not submitted.`)
  const submission = yield* pipe(context.submissions, Array.findFirst(byInputCase(input.id)), present(unsubmitted))
  const decoded = nativePayload(input.operation)(submission.input)
  const undecodable = Option.isNone(decoded)
  const decodable = blocking(`The submitted ${input.id} input decodes with the native ${input.operation} payload schema.`)

  return yield* failUnless(undecodable, decodable)
})

const noRejection = blocking("This requirement needs a declared rejected input.")

const invalidEvaluator = Effect.fn("SupportAcceptance.invalidRejected")(function* (context: EvaluationContext) {
  const rejections = inputsWith(context, "rejected")
  const declared = Array.isReadonlyArrayNonEmpty(rejections)

  yield* failUnless(declared, noRejection)
  yield* Effect.forEach(rejections, invalidCandidate(context))

  const subject = yield* preparedTarget(context)

  yield* subjectUnchanged(context, subject)

  return passing("The native-invalid input was rejected with HTTP 400 and nothing changed.")
})

const noAcceptedRead = blocking("This requirement needs an accepted support.auditTrail submission.")
const undecodedRead = failing("The audit read result does not decode with the native support.auditTrail success schema.")
const emptyRead = failing("The administrator received an empty audit trail.")

const auditAuthorizedEvaluator = Effect.fn("SupportAcceptance.auditAuthorized")(function* (context: EvaluationContext) {
  const reads = pipe(context.submissions, Array.filter(isAuditRead), Array.filter(isAccepted))
  const read = yield* pipe(reads, Array.head, present(noAcceptedRead))
  const subject = yield* preparedTarget(context)
  const records = yield* pipe(read.result, Option.flatMap(auditResult), present(undecodedRead))
  const before = yield* auditProbe(context, "before", subject)
  const after = yield* auditProbe(context, "after", subject)
  const nonEmpty = Array.isReadonlyArrayNonEmpty(records)
  const exact = Equal.equals(records, after)
  const unchanged = Equal.equals(before, after)
  const different = failing(`The audit read result differs from the recorded audit of case ${subject}.`)
  const changed = failing(`The audit trail of case ${subject} changed while it was read.`)

  yield* failUnless(nonEmpty, emptyRead)
  yield* failUnless(exact, different)
  yield* failUnless(unchanged, changed)

  const count = Array.length(records)

  return passing(`The administrator read exactly the ${count} recorded audit records of case ${subject}.`)
})

const deniedFailure = (input: InputCase) => isDenied(input.outcome) ? Option.some(input.outcome.failure) : Option.none<string>()
const noAuditRead = blocking("This requirement needs a support.auditTrail submission.")
const noDeclaredDenial = blocking("This requirement needs a declared audit denial.")
const leakedResult = failing("The denied audit read returned a result.")
const noDirectProbe = unsettled("No direct server probe of the audit read was recorded.")

const auditDeniedEvaluator = Effect.fn("SupportAcceptance.auditDenied")(function* (context: EvaluationContext) {
  const reads = Array.filter(context.submissions, isAuditRead)
  const read = yield* pipe(reads, Array.head, present(noAuditRead))
  const undeclared = blocking(`Input ${read.inputCase} is not declared.`)
  const declared = yield* pipe(context.scenario.inputs, Array.findFirst(byId(read.inputCase)), present(undeclared))
  const failure = deniedFailure(declared)
  const expectedTag = yield* present(noDeclaredDenial)(failure)
  const resultless = Option.isNone(read.result)

  yield* failUnless(resultless, leakedResult)

  const direct = yield* present(noDirectProbe)(context.directProbe)
  const sameStatus = Equal.equals(direct.status, read.status)
  const directTag = errorTag(direct)
  const sameTag = Option.contains(directTag, expectedTag)
  const enforced = sameStatus && sameTag
  const allowed = failing(`The direct server probe returned HTTP ${direct.status} instead of the declared ${expectedTag} denial.`)

  yield* failUnless(enforced, allowed)

  const subject = yield* preparedTarget(context)
  const records = yield* auditProbe(context, "after", subject)
  const exists = Array.isReadonlyArrayNonEmpty(records)
  const unshown = unsettled(`The administrator probe does not show that audit records exist for case ${subject}.`)

  yield* failUnless(exists, unshown)

  return passing(`The audit read was denied with ${expectedTag} in the browser and directly at the server while records exist.`)
})

const FailuresSchema = Schema.Array(Schema.String)

class Competitor extends Schema.Class<Competitor>("Competitor")({
  inputCase: Schema.String,
  lane: Schema.String,
  failures: FailuresSchema,
  action: Schema.String,
  agent: NullableTextSchema,
  note: NullableTextSchema,
  submission: Submission,
  sentAt: Schema.DateTimeUtc,
  receivedAt: Schema.DateTimeUtc,
}) {}

const isContendedInput = (input: InputCase) => isContended(input.outcome)
const contendedFailures = (input: InputCase) => isContended(input.outcome) ? Option.some(input.outcome.failures) : Option.none<ReadonlyArray<string>>()
const unlaned = Function.constant("(no lane)")
const claims = (inputCase: string) => (lane: Lane) => Array.contains(lane.inputs, inputCase)
const claimingLane = (inputCase: string) => (concurrency: Concurrency) => Array.findFirst(concurrency.lanes, claims(inputCase))
const laneOf = (context: EvaluationContext, inputCase: string) => pipe(context.scenario.concurrency, Option.flatMap(claimingLane(inputCase)), Option.map(Struct.get("id")), Option.getOrElse(unlaned))

const competitor = (context: EvaluationContext, subject: string, start: CaseRow) => Effect.fn("SupportAcceptance.competitor")(function* (input: InputCase) {
  const unsubmitted = unsettled(`Competing input ${input.id} has no captured browser submission.`)
  const submission = yield* pipe(context.submissions, Array.findFirst(byInputCase(input.id)), present(unsubmitted))
  const unexchanged = unsettled(`Competing submission ${input.id} has no recorded request exchange, so it is not shown to have been in flight.`)
  const exchange = yield* present(unexchanged)(submission.exchange)
  const untimed = unsettled(`The request exchange of ${input.id} does not carry readable instants.`)
  const sentAt = yield* pipe(exchange.sentAt, DateTime.make, present(untimed))
  const receivedAt = yield* pipe(exchange.receivedAt, DateTime.make, present(untimed))
  const notAdvance = unsettled(`Competing submission ${input.id} is not a native support.advanceCase payload.`)
  const advance = yield* pipe(submission.input, decodeAdvance, present(notAdvance))
  const sameCase = Equal.equals(advance.caseId, subject)
  const sameVersion = Equal.equals(advance.expectedVersion, start.version)
  const competing = sameCase && sameVersion
  const offTarget = unsettled(`Competing submission ${input.id} does not advance prepared case ${subject} at its prepared version ${start.version}, so it did not compete for that version.`)

  yield* failUnless(competing, offTarget)

  const undeclared = blocking(`Input ${input.id} declares no contended failures.`)
  const failures = yield* pipe(input, contendedFailures, present(undeclared))
  const lane = laneOf(context, input.id)
  const agent = optionalText(submission.input, "assignedAgentId")
  const note = optionalText(submission.input, "note")

  return Competitor.make({ inputCase: input.id, lane, failures, action: advance.action, agent, note, submission, sentAt, receivedAt })
})

const competitorLabel = (entrant: Competitor) => {
  const agent = labelOf(entrant.agent)
  const outcome = observedOutcome(entrant.submission)
  const sent = DateTime.formatIso(entrant.sentAt)
  const received = DateTime.formatIso(entrant.receivedAt)

  return `lane ${entrant.lane} ${entrant.inputCase} (agent ${agent}) sent ${sent}, answered ${received}: ${outcome} (HTTP ${entrant.submission.status})`
}

const competitionLabel = (entrants: ReadonlyArray<Competitor>) => pipe(entrants, Array.map(competitorLabel), Array.join("; "))

const inFlightWith = (other: Competitor) => (entrant: Competitor) => {
  const same = Equal.equals(entrant.inputCase, other.inputCase)
  const sentBeforeOtherAnswer = DateTime.isLessThan(entrant.sentAt, other.receivedAt)
  const otherSentBeforeAnswer = DateTime.isLessThan(other.sentAt, entrant.receivedAt)
  const overlapping = sentBeforeOtherAnswer && otherSentBeforeAnswer

  return same || overlapping
}

const overlapsEvery = (entrants: ReadonlyArray<Competitor>) => (entrant: Competitor) => Array.every(entrants, inFlightWith(entrant))
const isWinner = (entrant: Competitor) => isAccepted(entrant.submission)

const amongDeclared = (failures: ReadonlyArray<string>) => (tag: string) => Array.contains(failures, tag)

const refusedAsDeclared = (entrant: Competitor) => {
  const conflict = pipe(entrant.submission, errorTag, Option.exists(amongDeclared(entrant.failures)))
  const policy = Equal.equals(entrant.submission.status, 422)

  return conflict && policy
}

const refusalOf = (entrant: Competitor) => pipe(entrant.submission, errorTag, Option.getOrElse(unknownOutcome))

const transitionTarget = (action: string) => pipe(SupportCaseTransitions.transitions, Record.get(action), Option.map(Struct.get("to")), Option.getOrNull)

const winnerState = Effect.fn("SupportAcceptance.winnerState")(function* (context: EvaluationContext, subject: string, start: CaseRow, winner: Competitor) {
  const undecoded = failing(`The winning ${winner.inputCase} result does not decode with the native support.advanceCase success schema.`)
  const decodeResult = caseResult("support.advanceCase")
  const result = yield* pipe(winner.submission.result, Option.flatMap(decodeResult), present(undecoded))
  const version = start.version + 1
  const status = transitionTarget(winner.action)
  const expected = PayloadSchema.make({ ...start, status, version, assignedAgentId: winner.agent })
  const differences = differingFields(result, expected)
  const differenceList = listed(differences)
  const advancedOnce = Array.isReadonlyArrayEmpty(differences)
  const different = failing(`The winning ${winner.inputCase} result differs from prepared case ${subject} advanced once by ${winner.action} in: ${differenceList}.`)

  yield* failUnless(advancedOnce, different)

  const finalCases = rowsOf(context.after, "support_cases")
  const lost = failing(`Case ${subject} is missing from the reloaded support_cases view.`)
  const observed = yield* pipe(finalCases, Array.findFirst(byIdentity(subject)), present(lost))
  const undecodedRow = unsettled(`The reloaded row of case ${subject} does not decode with the native support_cases.list success schema.`)
  const decoded = yield* pipe(observed, decodeCase, present(undecodedRow))
  const survived = Equal.equals(decoded, result)
  const agentLabel = labelOf(winner.agent)
  const diverged = failing(`The reloaded row of case ${subject} is not the winning ${winner.inputCase} result at version ${version} with agent ${agentLabel}.`)

  yield* failUnless(survived, diverged)

  return result
})

const winnerHistory = Effect.fn("SupportAcceptance.winnerHistory")(function* (context: EvaluationContext, subject: string, winner: Competitor) {
  const beforeEvents = rowsOf(context.before, "support_case_events")
  const afterEvents = rowsOf(context.after, "support_case_events")
  const priorRows = Array.filter(beforeEvents, ofCase(subject))
  const currentRows = Array.filter(afterEvents, ofCase(subject))
  const kept = Array.every(priorRows, retainedIn(currentRows))
  const rewritten = failing(`The prior history of case ${subject} was not kept exactly.`)

  yield* failUnless(kept, rewritten)

  const priorIds = idsOf(priorRows)
  const appendedRows = Array.filter(currentRows, notIn(priorIds))
  const appended = yield* eventRows(appendedRows)
  const observed = Array.map(appended, observedEventKey)
  const kind = kindOf(winner.action)
  const winning = eventKey(kind, winner.agent, winner.note)
  const expected = Array.of(winning)
  const observedList = listed(observed)
  const single = Equal.equals(observed, expected)
  const mismatched = failing(`Case ${subject} history gained [${observedList}] during the race; expected exactly [${winning}].`)

  yield* failUnless(single, mismatched)

  return appended
})

const winnerAudit = Effect.fn("SupportAcceptance.winnerAudit")(function* (context: EvaluationContext, subject: string, start: CaseRow, winner: Competitor) {
  const prior = yield* auditProbe(context, "before", subject)
  const records = yield* auditProbe(context, "after", subject)
  const priorCount = Array.length(prior)
  const kept = pipe(records, Array.take(priorCount), Equal.equals(prior))
  const rewritten = failing(`The prior audit trail of case ${subject} was not kept exactly.`)

  yield* failUnless(kept, rewritten)

  const appended = Array.drop(records, priorCount)
  const observed = Array.map(appended, auditKey)
  const version = start.version + 1
  const id = auditId(subject, version)
  const winning = `${id}/${winner.action}/${auditOutcome}/${auditActor}/${subject}`
  const expected = Array.of(winning)
  const observedList = listed(observed)
  const single = Equal.equals(observed, expected)
  const mismatched = failing(`Case ${subject} audit gained [${observedList}] during the race; expected exactly [${winning}].`)

  yield* failUnless(single, mismatched)

  return appended
})

const auditFields = (record: AuditRow) => [record.id, record.action, record.outcome, record.actorId, record.targetId, record.traceId]
const mentions = (agent: string) => flow(auditFields, Array.contains<string | null>(agent))
const assignedTo = (agent: string) => fieldEquals("agentId", agent)
const trace = (found: boolean, place: string) => found ? Option.some(place) : Option.none<string>()
const tracedAt = (inputCase: string, agent: string) => (place: string) => `agent ${agent} of losing ${inputCase} appears in the ${place}`
const appearsInEvents = (events: ReadonlyArray<EventRow>) => (agent: string) => Array.some(events, assignedTo(agent))
const appearsInAudit = (audits: ReadonlyArray<AuditRow>) => (agent: string) => Array.some(audits, mentions(agent))

const loserTraces = (result: CaseRow, events: ReadonlyArray<EventRow>, audits: ReadonlyArray<AuditRow>) => (loser: Competitor) => {
  const agent = Option.fromNullishOr(loser.agent)
  const inCase = Option.exists(agent, Equal.equals(result.assignedAgentId))
  const inEvents = Option.exists(agent, appearsInEvents(events))
  const inAudit = Option.exists(agent, appearsInAudit(audits))
  const caseTrace = trace(inCase, "reloaded case")
  const eventTrace = trace(inEvents, "history appended during the race")
  const auditTrace = trace(inAudit, "audit appended during the race")
  const places = Array.getSomes([caseTrace, eventTrace, auditTrace])
  const agentLabel = labelOf(loser.agent)

  return Array.map(places, tracedAt(loser.inputCase, agentLabel))
}

const missingBarrier = unsettled("No submit barrier record was captured, so the competing submissions are not shown to have been held and released together.")
const unreleasedBarrier = unsettled("The submit barrier never released, so the competing submissions are not shown to have been released together.")
const noContest = blocking("This requirement needs at least two contended inputs.")

const singleWinnerEvaluator = Effect.fn("SupportAcceptance.singleWinner")(function* (context: EvaluationContext) {
  const barrier = yield* present(missingBarrier)(context.barrier)
  const releasedAt = yield* present(unreleasedBarrier)(barrier.releasedAt)
  const contended = Array.filter(context.scenario.inputs, isContendedInput)
  const contest = Array.length(contended) > 1

  yield* failUnless(contest, noContest)

  const subject = yield* preparedTarget(context)
  const start = yield* preparedStart(context, subject)
  const entrants = yield* Effect.forEach(contended, competitor(context, subject, start))
  const competition = competitionLabel(entrants)
  const agents = Array.map(entrants, Struct.get("agent"))
  const distinctAgents = Array.dedupe(agents)
  const distinctCount = Array.length(distinctAgents)
  const agentCount = Array.length(agents)
  const separable = Equal.equals(distinctCount, agentCount)
  const indistinct = unsettled(`The competing submissions name the same agent, so the winner's effect cannot be told apart from the loser's: ${competition}.`)

  yield* failUnless(separable, indistinct)

  const overlapping = Array.every(entrants, overlapsEvery(entrants))
  const sequential = unsettled(`The competing requests were not in flight together after the barrier released at ${releasedAt}: ${competition}.`)

  yield* failUnless(overlapping, sequential)

  const winners = Array.filter(entrants, isWinner)
  const losers = Array.filter(entrants, Predicate.not(isWinner))
  const winnerCount = Array.length(winners)
  const single = Equal.equals(winnerCount, 1)
  const notSingle = failing(`Expected exactly one accepted competing submission; ${winnerCount} were accepted: ${competition}.`)

  yield* failUnless(single, notSingle)

  const refused = Array.every(losers, refusedAsDeclared)
  const notRefused = failing(`Every losing submission must be refused with one of its declared documented refusals: ${competition}.`)

  yield* failUnless(refused, notRefused)

  const winner = yield* pipe(winners, Array.head, present(notSingle))
  const result = yield* winnerState(context, subject, start, winner)
  const events = yield* winnerHistory(context, subject, winner)
  const audits = yield* winnerAudit(context, subject, start, winner)
  const traces = Array.flatMap(losers, loserTraces(result, events, audits))
  const traceList = listed(traces)
  const untraced = Array.isReadonlyArrayEmpty(traces)
  const leaked = failing(`The losing submission left traces: ${traceList}. Competition: ${competition}.`)

  yield* failUnless(untraced, leaked)

  const agentLabel = labelOf(result.assignedAgentId)
  const refusals = pipe(losers, Array.map(refusalOf), Array.join(", "))

  return passing(`Exactly one competing submission on case ${subject} at version ${start.version} won after the barrier released at ${releasedAt}: ${competition}. The loser was refused with ${refusals}, a documented lifecycle refusal. The reloaded case is the winning result at version ${result.version} with agent ${agentLabel}; its history and audit each gained exactly one record of the winning ${winner.action}, and the losing agent appears in none of them.`)
})

const instantOf = (event: EventRow) => DateTime.formatIso(event.occurredAt)

const regression = (label: string) => ([earlier, later]: readonly [EventRow, EventRow]) => {
  const earlierAt = instantOf(earlier)
  const laterAt = instantOf(later)

  return `${label}: ${later.kind} at ${laterAt} follows ${earlier.kind} at ${earlierAt}`
}

const occursBefore = (instant: DateTime.Utc) => (event: EventRow) => DateTime.isLessThan(event.occurredAt, instant)

const precedesOpening = (label: string, opened: string) => (event: EventRow) => {
  const at = instantOf(event)

  return `${label}: first event ${event.kind} at ${at} precedes the case opening at ${opened}`
}

const chronologyProblems = (label: string, openedAt: DateTime.Utc) => (events: ReadonlyArray<EventRow>) => {
  const successors = Array.drop(events, 1)
  const pairs = Array.zip(events, successors)
  const regressions = pipe(pairs, Array.filter(Predicate.not(ordered)), Array.map(regression(label)))
  const opened = DateTime.formatIso(openedAt)
  const early = pipe(events, Array.head, Option.filter(occursBefore(openedAt)), Option.map(precedesOpening(label, opened)))

  return [...regressions, ...Option.toArray(early)]
}

const occursAfter = (event: EventRow) => (prior: EventRow) => DateTime.isLessThan(event.occurredAt, prior.occurredAt)
const backdated = (prior: ReadonlyArray<EventRow>) => (event: EventRow) => Array.some(prior, occursAfter(event))

const backdatedLabel = (event: EventRow) => {
  const at = instantOf(event)

  return `appended ${event.kind} at ${at} occurs before a prior event of the case`
}

const detailOfSubject = (subject: string) => (record: ProbeRecord) => {
  const detail = Equal.equals(record.probe, "case-detail")
  const same = Equal.equals(record.subject, subject)

  return detail && same
}

const detailChronology = (subject: string) => Effect.fn("SupportAcceptance.detailChronology")(function* (record: ProbeRecord) {
  const undecoded = failing(`The case-detail probe ${record.phase} of case ${subject} does not decode with the native support.caseDetail success schema.`)
  const detail = yield* pipe(record.result, Option.flatMap(detailResult), present(undecoded))
  const label = `case-detail ${record.phase}`

  return chronologyProblems(label, detail.case.openedAt)(detail.events)
})

const historyChronologyEvaluator = Effect.fn("SupportAcceptance.historyChronology")(function* (context: EvaluationContext) {
  const subject = yield* pipe(context, subjectCase, present(noSubject))
  const finalCases = rowsOf(context.after, "support_cases")
  const unlisted = unsettled(`Case ${subject} is not in the reloaded support_cases view, so its opening time is not observed.`)
  const listedCase = yield* pipe(finalCases, Array.findFirst(byIdentity(subject)), present(unlisted))
  const undecoded = unsettled(`The reloaded row of case ${subject} does not decode with the native support_cases.list success schema.`)
  const reloaded = yield* pipe(listedCase, decodeCase, present(undecoded))
  const beforeEvents = rowsOf(context.before, "support_case_events")
  const afterEvents = rowsOf(context.after, "support_case_events")
  const priorRows = Array.filter(beforeEvents, ofCase(subject))
  const currentRows = Array.filter(afterEvents, ofCase(subject))
  const events = yield* eventRows(currentRows)
  const recorded = Array.isReadonlyArrayNonEmpty(events)
  const unrecorded = unsettled(`Case ${subject} has no events in the reloaded support_case_events view, so there is no history to order.`)

  yield* failUnless(recorded, unrecorded)

  const prior = yield* eventRows(priorRows)
  const priorIds = idsOf(priorRows)
  const appendedRows = Array.filter(currentRows, notIn(priorIds))
  const appended = yield* eventRows(appendedRows)
  const backdatedProblems = pipe(appended, Array.filter(backdated(prior)), Array.map(backdatedLabel))
  const listProblems = chronologyProblems("reloaded support_case_events list", reloaded.openedAt)(events)
  const records = pipe(context.probes, Array.filter(detailOfSubject(subject)), Array.filter(succeededProbe))
  const probed = Array.isReadonlyArrayNonEmpty(records)
  const unprobed = unsettled(`No successful case-detail probe of case ${subject} was recorded, so its history order has no independent observation.`)

  yield* failUnless(probed, unprobed)

  const detailProblems = yield* Effect.forEach(records, detailChronology(subject))
  const problems = [...listProblems, ...backdatedProblems, ...Array.flatten(detailProblems)]
  const problemList = listed(problems)
  const chronological = Array.isReadonlyArrayEmpty(problems)
  const unordered = failing(`Case ${subject} history is not chronological: ${problemList}.`)

  yield* failUnless(chronological, unordered)

  const opened = DateTime.formatIso(reloaded.openedAt)
  const eventCount = Array.length(events)
  const recordCount = Array.length(records)
  const appendedCount = Array.length(appended)
  const priorCount = Array.length(prior)

  return passing(`Case ${subject}: its ${eventCount} reloaded events and ${recordCount} case-detail observations never go back in occurrence time, it opened at ${opened} no later than its first event, and its ${appendedCount} appended events occur no earlier than its ${priorCount} prior events.`)
})

type Evaluator = (context: EvaluationContext) => Verdict<Assertion>

const evaluators = HashMap.make<ReadonlyArray<readonly [string, Evaluator]>>(
  ["opened-case", openedCaseEvaluator],
  ["lifecycle-transitions", lifecycleEvaluator],
  ["ordered-history", historyEvaluator],
  ["joined-detail", joinedEvaluator],
  ["audit-recorded", auditRecordedEvaluator],
  ["unrelated-unchanged", unrelatedEvaluator],
  ["denied-unchanged", deniedEvaluator],
  ["invalid-rejected", invalidEvaluator],
  ["audit-authorized", auditAuthorizedEvaluator],
  ["audit-denied", auditDeniedEvaluator],
  ["single-winner", singleWinnerEvaluator],
  ["history-chronology", historyChronologyEvaluator],
)

const revisionEntries: ReadonlyArray<readonly [string, string]> = [
  ["opened-case", "1"],
  ["lifecycle-transitions", "2"],
  ["ordered-history", "2"],
  ["joined-detail", "2"],
  ["audit-recorded", "2"],
  ["unrelated-unchanged", "1"],
  ["denied-unchanged", "1"],
  ["invalid-rejected", "1"],
  ["audit-authorized", "1"],
  ["audit-denied", "1"],
  ["single-winner", "2"],
  ["history-chronology", "1"],
]

export const evaluatorRevisions: Readonly<Record<string, string>> = Record.fromEntries(revisionEntries)

const resultFor = (requirement: BoundRequirement, context: EvaluationContext) => (verdict: Assertion) => RequirementResult.make({
  requirement: requirement.reference,
  requirementRevision: requirement.revision,
  scenario: context.scenario.id,
  scenarioRevision: context.scenario.revision,
  evaluator: requirement.evaluator,
  evaluatorRevision: requirement.evaluatorRevision,
  basis: "executable assertion",
  status: verdict.status,
  explanation: verdict.explanation,
  evidence: context.evidence,
})

const evaluate = Effect.fn("SupportAcceptance.evaluate")(function* (requirement: BoundRequirement, context: EvaluationContext) {
  const evaluator = HashMap.get(evaluators, requirement.evaluator)
  const report = resultFor(requirement, context)

  if (Option.isNone(evaluator)) return yield* AcceptanceError.make({ boundary: "requirement-evaluation", message: `Unknown evaluator: ${requirement.evaluator}` })

  const problem = prerequisiteProblem(context)

  if (Option.isSome(problem)) return report(problem.value)

  const assessment = evaluator.value(context)
  const verdict = yield* Effect.match(assessment, { onFailure: Function.identity, onSuccess: Function.identity })

  return report(verdict)
})

const evaluationService = RequirementEvaluation.of({ evaluate })

export const evaluationLayer = Layer.succeed(RequirementEvaluation, evaluationService)

const ControlKindSchema = Schema.Literals(["defect", "clean-control", "missing-evidence-control", "blocked-control"])
const ExpectedStatusesSchema = Schema.Record(Schema.String, ResultStatusSchema)
const NamesSchema = Schema.Array(Schema.String)
const ResultsSchema = Schema.Array(RequirementResult)

type ExpectedStatuses = typeof ExpectedStatusesSchema.Type

class DefectCase extends Schema.Class<DefectCase>("DefectCase")({
  id: Schema.String,
  kind: ControlKindSchema,
  context: EvaluationContext,
  expectedStatuses: ExpectedStatusesSchema,
}) {}

class VerifierCase extends Schema.Class<VerifierCase>("VerifierCase")({
  id: Schema.String,
  kind: ControlKindSchema,
  expectedFailingCriteria: NamesSchema,
  expectedStatuses: ExpectedStatusesSchema,
  observations: EvaluationContext,
  results: ResultsSchema,
  falseAcceptance: Schema.Number,
  falseRejection: Schema.Number,
  unexpectedStatuses: Schema.Number,
  blocked: Schema.Number,
  inconclusive: Schema.Number,
}) {}

class VerifierSummary extends Schema.Class<VerifierSummary>("VerifierSummary")({
  cases: Schema.Number,
  criteria: Schema.Number,
  falseAcceptance: Schema.Number,
  falseRejection: Schema.Number,
  unexpectedStatuses: Schema.Number,
  blocked: Schema.Number,
  inconclusive: Schema.Number,
  missingEvidenceControls: Schema.Number,
}) {}

const VerifierCasesSchema = Schema.Array(VerifierCase)

export class VerifierReport extends Schema.Class<VerifierReport>("VerifierReport")({
  revision: Schema.String,
  basis: AssertionBasisSchema,
  evidenceSource: Schema.String,
  cases: VerifierCasesSchema,
  summary: VerifierSummary,
}) {}

class StepControl extends Schema.Class<StepControl>("StepControl")({
  inputCase: Schema.String,
  action: Schema.String,
  status: Schema.String,
  agent: NullableTextSchema,
  submittedAgent: NullableTextSchema,
  note: NullableTextSchema,
  version: Schema.Int,
}) {}

const customerId = "customer-ada"
const customerName = "Ada Analytics"
const onDutyAgent = "agent-grace"
const offDutyAgent = "agent-linus"
const secondAgent = "agent-erin"
const capturedId = "0192a000-0000-7000-8000-000000000001"
const targetId = "0192a000-0000-7000-8000-000000000002"
const unrelatedId = "0192a000-0000-7000-8000-000000000003"
const capturedSubject = "Cannot export quarterly report"
const triageNote = "Reproduced from the export payload."
const times = ["2026-10-10T10:00:00.000Z", "2026-10-10T10:01:00.000Z", "2026-10-10T10:02:00.000Z", "2026-10-10T10:03:00.000Z", "2026-10-10T10:04:00.000Z", "2026-10-10T10:05:00.000Z"]
const lateTime = Function.constant("2026-10-10T11:00:00.000Z")
const timeAt = (index: number) => pipe(times, Array.get(index), Option.getOrElse(lateTime))
const customerRow = PayloadSchema.make({ id: customerId, name: customerName })
const onDutyRow = PayloadSchema.make({ id: onDutyAgent, name: "Grace Hopper", onDuty: true })
const offDutyRow = PayloadSchema.make({ id: offDutyAgent, name: "Linus Pauling", onDuty: false })
const secondOnDutyRow = PayloadSchema.make({ id: secondAgent, name: "Erin Walsh", onDuty: true })
const agentControls = [onDutyRow, secondOnDutyRow, offDutyRow]
const customerControls = [customerRow]
const unrelatedCase = PayloadSchema.make({ id: unrelatedId, customerId, subject: "Printer queue stalls", priority: "low", status: "triaged", assignedAgentId: null, openedAt: "2026-10-01T09:00:00.000Z", version: 2 })
const targetCase = PayloadSchema.make({ id: targetId, customerId, subject: "Invoice totals disagree", priority: "normal", status: "triaged", assignedAgentId: null, openedAt: "2026-10-02T09:00:00.000Z", version: 2 })
const mutatedTarget = PayloadSchema.make({ ...targetCase, status: "assigned", assignedAgentId: onDutyAgent, version: 3 })
const mutatedUnrelated = PayloadSchema.make({ ...unrelatedCase, subject: "Rewritten by an unrelated command" })

const unrelatedEvents = [
  PayloadSchema.make({ id: "0192a000-0000-7000-8000-000000000101", caseId: unrelatedId, kind: "opened", agentId: null, note: null, occurredAt: "2026-10-01T09:00:00.000Z" }),
  PayloadSchema.make({ id: "0192a000-0000-7000-8000-000000000102", caseId: unrelatedId, kind: "triaged", agentId: null, note: "Queue reproduced.", occurredAt: "2026-10-01T09:05:00.000Z" }),
]

const targetEvents = [
  PayloadSchema.make({ id: "0192a000-0000-7000-8000-000000000201", caseId: targetId, kind: "opened", agentId: null, note: null, occurredAt: "2026-10-02T09:00:00.000Z" }),
  PayloadSchema.make({ id: "0192a000-0000-7000-8000-000000000202", caseId: targetId, kind: "triaged", agentId: null, note: "Totals reproduced.", occurredAt: "2026-10-02T09:05:00.000Z" }),
]

const extraTargetEvent = PayloadSchema.make({ id: "0192a000-0000-7000-8000-000000000203", caseId: targetId, kind: "assigned", agentId: onDutyAgent, note: null, occurredAt: "2026-10-10T10:01:00.000Z" })
const duplicateEvent = PayloadSchema.make({ id: "0192a000-0000-7000-8000-000000000399", caseId: capturedId, kind: "triaged", agentId: null, note: triageNote, occurredAt: "2026-10-10T10:01:00.000Z" })
const priorSubjectEvent = PayloadSchema.make({ id: "0192a000-0000-7000-8000-000000000398", caseId: capturedId, kind: "opened", agentId: null, note: null, occurredAt: "2026-10-09T10:00:00.000Z" })

const auditRow = (caseId: string, version: number, action: string, occurredAt: string) => {
  const id = auditId(caseId, version)

  return PayloadSchema.make({ id, occurredAt, action, outcome: auditOutcome, actorId: auditActor, targetId: caseId, traceId: null })
}

const unrelatedOpenAudit = auditRow(unrelatedId, 1, "open", "2026-10-01T09:00:00.000Z")
const unrelatedTriageAudit = auditRow(unrelatedId, 2, "triage", "2026-10-01T09:05:00.000Z")
const unrelatedAssignAudit = auditRow(unrelatedId, 3, "assign", "2026-10-10T10:06:00.000Z")
const targetOpenAudit = auditRow(targetId, 1, "open", "2026-10-02T09:00:00.000Z")
const targetTriageAudit = auditRow(targetId, 2, "triage", "2026-10-02T09:05:00.000Z")
const priorSubjectAudit = auditRow(capturedId, 0, "open", "2026-10-09T10:00:00.000Z")
const unrelatedAudit = [unrelatedOpenAudit, unrelatedTriageAudit]
const targetAudit = [targetOpenAudit, targetTriageAudit]
const truncatedTargetAudit = [targetOpenAudit]
const openTargetAudit = [targetOpenAudit]
const changedUnrelatedAudit = [unrelatedOpenAudit, unrelatedTriageAudit, unrelatedAssignAudit]

const stepControl = (inputCase: string, status: string, agent: string | null, note: string | null, version: number) => {
  const assigning = Equal.equals(inputCase, "assign")
  const submittedAgent = assigning ? agent : null

  return StepControl.make({ inputCase, action: inputCase, status, agent, submittedAgent, note, version })
}

const openStep = stepControl("open", "open", null, null, 1)
const triageStep = stepControl("triage", "triaged", null, triageNote, 2)
const assignStep = stepControl("assign", "assigned", onDutyAgent, null, 3)
const resolveStep = stepControl("resolve", "resolved", onDutyAgent, "Export permission repaired.", 4)
const reopenStep = stepControl("reopen", "triaged", null, "The customer reports the quarterly export failing again.", 5)
const cleanSteps = Array.make(openStep, triageStep, assignStep, resolveStep, reopenStep)
const preparedSteps = Array.make(triageStep, assignStep)
const PayloadsSchema = Schema.Array(PayloadSchema)

class ControlSubject extends Schema.Class<ControlSubject>("ControlSubject")({
  id: Schema.String,
  opened: PayloadSchema,
  priorEvents: PayloadsSchema,
  eventPrefix: Schema.String,
}) {}

const capturedOpenedAt = timeAt(0)
const capturedOpened = PayloadSchema.make({ id: capturedId, customerId, subject: capturedSubject, priority: "high", status: "open", assignedAgentId: null, openedAt: capturedOpenedAt, version: 1 })
const capturedControl = ControlSubject.make({ id: capturedId, opened: capturedOpened, priorEvents: [], eventPrefix: "0192a000-0000-7000-8000-00000000030" })
const openTargetCase = PayloadSchema.make({ ...targetCase, status: "open", version: 1 })
const openTargetEvents = Array.take(targetEvents, 1)
const preparedControl = ControlSubject.make({ id: targetId, opened: openTargetCase, priorEvents: openTargetEvents, eventPrefix: "0192a000-0000-7000-8000-00000000040" })
const stepResult = (subject: ControlSubject) => (step: StepControl) => PayloadSchema.make({ ...subject.opened, status: step.status, assignedAgentId: step.agent, version: step.version })

const withText = (field: string, value: string | null) => (payload: Payload) => Predicate.isNull(value) ? payload : Record.set(payload, field, value)
const isOpenControl = (step: StepControl) => Equal.equals(step.action, "open")
const openInput = PayloadSchema.make({ customerId, subject: capturedSubject, priority: "high" })

const stepInput = (subject: ControlSubject) => (step: StepControl) => {
  const expectedVersion = step.version - 1
  const advance = PayloadSchema.make({ caseId: subject.id, expectedVersion, action: step.action })
  const opening = isOpenControl(step)

  return opening ? openInput : pipe(advance, withText("note", step.note), withText("assignedAgentId", step.submittedAgent))
}

const stepOperation = (step: StepControl) => isOpenControl(step) ? "support.openCase" : "support.advanceCase"

const stepEvent = (subject: ControlSubject) => (step: StepControl, index: number) => {
  const kind = kindOf(step.action)
  const occurredAt = timeAt(index)

  return PayloadSchema.make({ id: `${subject.eventPrefix}${index}`, caseId: subject.id, kind, agentId: step.agent, note: step.note, occurredAt })
}

const stepAudit = (subject: ControlSubject) => (step: StepControl, index: number) => {
  const occurredAt = timeAt(index)

  return auditRow(subject.id, step.version, step.action, occurredAt)
}

const agentRowOf = (agent: string | null) => Predicate.isNull(agent) ? Option.none<Payload>() : Array.findFirst(agentControls, byIdentity(agent))
const noError = Option.none<unknown>()
const noResult = Option.none<unknown>()
const noExchange = Option.none<Exchange>()
const noFeedback = Option.none<string>()

const stepSubmission = (subject: ControlSubject) => (step: StepControl, index: number) => {
  const result = stepResult(subject)(step)
  const at = timeAt(index)
  const input = stepInput(subject)(step)
  const operation = stepOperation(step)

  return Submission.make({ inputCase: step.inputCase, operation, input, status: 200, result: Option.some(result), error: noError, at, exchange: noExchange, feedback: noFeedback })
}

const probeRecord = (probe: ProbeRecord["probe"], phase: string, subject: string, result: unknown) => {
  const at = timeAt(5)
  const value = Option.some(result)

  return ProbeRecord.make({ probe, phase, subject, actor: "administrator", at, status: 200, result: value, error: noError })
}

const auditProbeRecord = (phase: string, subject: string, records: ReadonlyArray<Payload>) => probeRecord("audit-trail", phase, subject, records)

const detailProbe = (subject: ControlSubject, steps: ReadonlyArray<StepControl>) => (step: StepControl, index: number) => {
  const stepEvents = pipe(steps, Array.map(stepEvent(subject)), Array.take(index + 1))
  const events = [...subject.priorEvents, ...stepEvents]
  const agent = pipe(step.agent, agentRowOf, Option.getOrNull)
  const result = stepResult(subject)(step)
  const detail = PayloadSchema.make({ case: result, customer: customerRow, agent, events })

  return probeRecord("case-detail", `after:${step.inputCase}`, subject.id, detail)
}

const view = (reloaded: boolean) => (resource: string, rows: ReadonlyArray<Payload>) => Observation.make({ operation: `${resource}.list`, resource, loaded: true, unfiltered: true, complete: true, rows, reloaded, screenshot: Option.none() })
const beforeView = view(false)
const afterView = view(true)

const views = (observe: typeof beforeView, cases: ReadonlyArray<Payload>, events: ReadonlyArray<Payload>) => [
  observe("support_cases", cases),
  observe("support_case_events", events),
  observe("support_agents", agentControls),
  observe("support_customers", customerControls),
]

const baseFacts = PayloadSchema.make({ "customer.id": customerId, "customer.name": customerName, "agent.on-duty.id": onDutyAgent, "agent.second-on-duty.id": secondAgent, "agent.off-duty.id": offDutyAgent })
const targetFacts = PayloadSchema.make({ ...baseFacts, "target.id": targetId, "target.version": 2 })
const openTargetFacts = PayloadSchema.make({ ...baseFacts, "target.id": targetId, "target.version": 1 })
const emptyInput = Function.constant(emptyPayload)
const inputById = (submissions: ReadonlyArray<Submission>, id: string) => pipe(submissions, Array.findFirst(byInputCase(id)), Option.map(Struct.get("input")), Option.getOrElse(emptyInput))

const candidateFor = (submissions: ReadonlyArray<Submission>) => (input: InputCase) => {
  const submitted = inputById(submissions, input.id)

  return Candidate.make({
    inputCase: input.id,
    operation: input.operation,
    description: input.description,
    input: submitted,
    sources: input.fields,
    validity: input.validity,
    nativeValidation: "deliberately constructed verifier control",
    provenance: "deliberately constructed observation control; not browser or model execution",
    seed: 0,
  })
}

const fixtureFor = (scenario: Scenario, facts: Payload, tracked: ReadonlyArray<string>) => PreparedFixture.make({ binding: scenario.fixture, revision: "verifier-control", url: "about:blank", actor: scenario.actor, facts, tracked })
const unrelatedTracked = [unrelatedId]
const targetTracked = [targetId, unrelatedId]
const unrelatedCases = [unrelatedCase]
const preparedCases = [unrelatedCase, targetCase]
const preparedEvents = [...unrelatedEvents, ...targetEvents]
const openPreparedCases = [unrelatedCase, openTargetCase]
const openPreparedEvents = [...unrelatedEvents, ...openTargetEvents]
const noInterruption = Option.none<string>()
const noDirectSubmission = Option.none<Submission>()
const noBarrier = Option.none<BarrierRecord>()
const noWatch = Option.none<WatchRecord>()

const lifecycleContext = (scenario: Scenario) => (steps: ReadonlyArray<StepControl>) => {
  const submissions = Array.map(steps, stepSubmission(capturedControl))
  const events = Array.map(steps, stepEvent(capturedControl))
  const audits = Array.map(steps, stepAudit(capturedControl))
  const last = pipe(steps, Array.last, Option.map(stepResult(capturedControl)), Option.toArray)
  const details = Array.map(steps, detailProbe(capturedControl, steps))
  const unrelatedBefore = auditProbeRecord("before", unrelatedId, unrelatedAudit)
  const unrelatedAfter = auditProbeRecord("after", unrelatedId, unrelatedAudit)
  const capturedAfter = auditProbeRecord("after", capturedId, audits)
  const fixture = fixtureFor(scenario, baseFacts, unrelatedTracked)
  const candidates = Array.map(scenario.inputs, candidateFor(submissions))
  const before = views(beforeView, unrelatedCases, unrelatedEvents)
  const after = views(afterView, [...last, unrelatedCase], [...unrelatedEvents, ...events])

  return EvaluationContext.make({
    scenario,
    fixture,
    candidates,
    submissions,
    before,
    after,
    probes: [...details, unrelatedBefore, unrelatedAfter, capturedAfter],
    directProbe: noDirectSubmission,
    barrier: noBarrier,
    watch: noWatch,
    interruption: noInterruption,
    evidence: [],
  })
}

const preparedContext = (scenario: Scenario) => (steps: ReadonlyArray<StepControl>) => {
  const submissions = Array.map(steps, stepSubmission(preparedControl))
  const events = Array.map(steps, stepEvent(preparedControl))
  const audits = Array.map(steps, stepAudit(preparedControl))
  const last = pipe(steps, Array.last, Option.map(stepResult(preparedControl)), Option.toArray)
  const details = Array.map(steps, detailProbe(preparedControl, steps))
  const targetAudits = [...openTargetAudit, ...audits]
  const targetBefore = auditProbeRecord("before", targetId, openTargetAudit)
  const targetAfter = auditProbeRecord("after", targetId, targetAudits)
  const unrelatedBefore = auditProbeRecord("before", unrelatedId, unrelatedAudit)
  const unrelatedAfter = auditProbeRecord("after", unrelatedId, unrelatedAudit)
  const fixture = fixtureFor(scenario, openTargetFacts, targetTracked)
  const candidates = Array.map(scenario.inputs, candidateFor(submissions))
  const before = views(beforeView, openPreparedCases, openPreparedEvents)
  const after = views(afterView, [unrelatedCase, ...last], [...openPreparedEvents, ...events])

  return EvaluationContext.make({
    scenario,
    fixture,
    candidates,
    submissions,
    before,
    after,
    probes: [...details, targetBefore, targetAfter, unrelatedBefore, unrelatedAfter],
    directProbe: noDirectSubmission,
    barrier: noBarrier,
    watch: noWatch,
    interruption: noInterruption,
    evidence: [],
  })
}

const firstInputId = (scenario: Scenario) => pipe(scenario.inputs, Array.head, Option.map(Struct.get("id")), Option.getOrElse(undeclaredLabel))
const firstOperation = (scenario: Scenario) => pipe(scenario.operations, Array.head, Option.getOrElse(undeclaredLabel))

const attempt = (scenario: Scenario, input: Payload, status: number, result: Option.Option<unknown>, error: Option.Option<unknown>) => {
  const inputCase = firstInputId(scenario)
  const operation = firstOperation(scenario)
  const at = timeAt(1)

  return Submission.make({ inputCase, operation, input, status, result, error, at, exchange: noExchange, feedback: noFeedback })
}

const refusal = (tag: string) => PayloadSchema.make({ _tag: tag, message: `${tag} refused by the application` })

const deniedAttempt = (scenario: Scenario, input: Payload, tag: string) => {
  const error = refusal(tag)
  const tagged = Option.some(error)

  return attempt(scenario, input, 422, noResult, tagged)
}

const acceptedAttempt = (scenario: Scenario, input: Payload, result: unknown) => {
  const value = Option.some(result)

  return attempt(scenario, input, 200, value, noError)
}

const targetContext = (scenario: Scenario, submission: Submission, directProbe: Option.Option<Submission>) => {
  const submissions = [submission]
  const fixture = fixtureFor(scenario, targetFacts, targetTracked)
  const candidates = Array.map(scenario.inputs, candidateFor(submissions))
  const before = views(beforeView, preparedCases, preparedEvents)
  const after = views(afterView, preparedCases, preparedEvents)
  const targetBefore = auditProbeRecord("before", targetId, targetAudit)
  const targetAfter = auditProbeRecord("after", targetId, targetAudit)
  const unrelatedBefore = auditProbeRecord("before", unrelatedId, unrelatedAudit)
  const unrelatedAfter = auditProbeRecord("after", unrelatedId, unrelatedAudit)

  return EvaluationContext.make({
    scenario,
    fixture,
    candidates,
    submissions,
    before,
    after,
    probes: [targetBefore, targetAfter, unrelatedBefore, unrelatedAfter],
    directProbe,
    barrier: noBarrier,
    watch: noWatch,
    interruption: noInterruption,
    evidence: [],
  })
}

type ViewChange = (observation: Observation) => Observation

const changeView = (resource: string, change: ViewChange) => (observation: Observation) => byResource(resource)(observation) ? change(observation) : observation
const withRows = (rows: ReadonlyArray<Payload>) => (observation: Observation) => Observation.make({ ...observation, rows })
const unloaded = (observation: Observation) => Observation.make({ ...observation, loaded: false, rows: [] })
const filtered = (observation: Observation) => Observation.make({ ...observation, unfiltered: false })
const incomplete = (observation: Observation) => Observation.make({ ...observation, complete: false })
const unreloaded = (observation: Observation) => Observation.make({ ...observation, reloaded: false })

const afterChange = (resource: string, change: ViewChange) => (context: EvaluationContext) => {
  const after = Array.map(context.after, changeView(resource, change))

  return EvaluationContext.make({ ...context, after })
}

const beforeChange = (resource: string, change: ViewChange) => (context: EvaluationContext) => {
  const before = Array.map(context.before, changeView(resource, change))

  return EvaluationContext.make({ ...context, before })
}

const afterRows = (resource: string, rows: ReadonlyArray<Payload>) => afterChange(resource, withRows(rows))
const beforeRows = (resource: string, rows: ReadonlyArray<Payload>) => beforeChange(resource, withRows(rows))

const withoutProbe = (target: ProbeTarget) => (context: EvaluationContext) => {
  const probes = Array.filter(context.probes, Predicate.not(probeMatches(target)))

  return EvaluationContext.make({ ...context, probes })
}

const replacingProbe = (target: ProbeTarget, replacement: ProbeRecord) => (record: ProbeRecord) => probeMatches(target)(record) ? replacement : record

const withProbe = (target: ProbeTarget, replacement: ProbeRecord) => (context: EvaluationContext) => {
  const probes = Array.map(context.probes, replacingProbe(target, replacement))

  return EvaluationContext.make({ ...context, probes })
}

const addingProbe = (record: ProbeRecord) => (context: EvaluationContext) => {
  const probes = Array.append(context.probes, record)

  return EvaluationContext.make({ ...context, probes })
}

const replacingStep = (inputCase: string, change: (step: StepControl) => StepControl) => (step: StepControl) => Equal.equals(step.inputCase, inputCase) ? change(step) : step

const skippingVersion = (step: StepControl) => {
  const skipped = step.version + 1
  const later = step.version >= 3

  return later ? StepControl.make({ ...step, version: skipped }) : step
}

const wronglyAssigned = (step: StepControl) => StepControl.make({ ...step, status: "assigned" })
const keptAgent = (step: StepControl) => StepControl.make({ ...step, agent: onDutyAgent })

const offDutyAssignment = (step: StepControl) => {
  const assigning = Equal.equals(step.action, "assign")
  const submittedAgent = assigning ? offDutyAgent : null

  return StepControl.make({ ...step, agent: offDutyAgent, submittedAgent })
}

const requiredBy = (scenario: Scenario) => (requirement: Requirement) => Array.contains(scenario.requirements, requirement.id)
const requirementsOf = (scenario: Scenario) => (catalog: Catalog) => pipe(catalog.requirements, Array.filter(requiredBy(scenario)), Array.map(bindLocalRequirement), Array.getSomes)
const evaluatorStatus = (status: Status) => (requirement: BoundRequirement) => [requirement.evaluator, status] as const

const uniform = (catalog: Catalog, scenario: Scenario, status: Status): ExpectedStatuses => pipe(catalog, requirementsOf(scenario), Array.map(evaluatorStatus(status)), Record.fromEntries)

const settingStatus = (status: Status) => (current: ExpectedStatuses, name: string) => Record.set(current, name, status)
const overriding = (status: Status, names: ReadonlyArray<string>) => (statuses: ExpectedStatuses) => Array.reduce(names, statuses, settingStatus(status))

class ControlScenarios extends Schema.Class<ControlScenarios>("ControlScenarios")({
  lifecycle: Scenario,
  desk: Scenario,
  stale: Scenario,
  offDuty: Scenario,
  unassigned: Scenario,
  transition: Scenario,
  invalid: Scenario,
  admin: Scenario,
  reader: Scenario,
  visitor: Scenario,
  race: Scenario,
}) {}

const lifecycleEvaluators = ["opened-case", "lifecycle-transitions", "ordered-history", "history-chronology", "joined-detail", "audit-recorded", "unrelated-unchanged"]
const creationEvaluators = ["opened-case", "lifecycle-transitions", "ordered-history"]
const transitionEvaluators = ["lifecycle-transitions"]
const historyEvaluators = ["ordered-history"]
const joinEvaluators = ["joined-detail"]
const auditEvaluators = ["audit-recorded"]
const preservationEvaluators = ["unrelated-unchanged"]
const historyAndPreservation = ["ordered-history", "unrelated-unchanged"]
const historyAndChronology = ["ordered-history", "history-chronology"]
const chronologyEvaluators = ["history-chronology"]
const raceEvaluators = ["single-winner", "history-chronology", "unrelated-unchanged"]
const winnerEvaluators = ["single-winner"]
const denialEvaluators = ["denied-unchanged"]
const denialAndPreservation = ["denied-unchanged", "unrelated-unchanged"]
const rejectionAndPreservation = ["invalid-rejected", "unrelated-unchanged"]
const auditDenialEvaluators = ["audit-denied"]
const auditDenialAndPreservation = ["audit-denied", "unrelated-unchanged"]
const auditReadEvaluators = ["audit-authorized"]
const cleanEvents = Array.map(cleanSteps, stepEvent(capturedControl))
const cleanAudits = Array.map(cleanSteps, stepAudit(capturedControl))
const preparedStepEvents = Array.map(preparedSteps, stepEvent(preparedControl))
const preparedStepAudits = Array.map(preparedSteps, stepAudit(preparedControl))
const priorlessPreparedEvents = [...unrelatedEvents, ...preparedStepEvents]
const firstEvent = Array.take(cleanEvents, 1)
const firstTwoEvents = Array.take(cleanEvents, 2)
const firstThreeEvents = Array.take(cleanEvents, 3)
const laterEvents = Array.drop(cleanEvents, 2)
const lastTwoEvents = Array.drop(cleanEvents, 3)
const swappedEvents = Array.reverse(lastTwoEvents)
const missingEvents = Array.remove(cleanEvents, 3)
const duplicatedEvents = [...firstTwoEvents, duplicateEvent, ...laterEvents]
const reorderedEvents = [...firstThreeEvents, ...swappedEvents]
const repeatedIdentityEvents = [...unrelatedEvents, ...cleanEvents, ...firstEvent]
const keptUnrelatedEvent = Array.take(unrelatedEvents, 1)
const deletedUnrelatedEvents = [...keptUnrelatedEvent, ...cleanEvents]
const missingAudits = Array.remove(cleanAudits, 2)
const firstTwoAudits = Array.take(cleanAudits, 2)
const triageAudit = Array.drop(firstTwoAudits, 1)
const laterAudits = Array.drop(cleanAudits, 2)
const duplicatedAudits = [...firstTwoAudits, ...triageAudit, ...laterAudits]
const priorSubjectAudits = [priorSubjectAudit, ...cleanAudits]
const capturedResult = stepResult(capturedControl)
const openedResult = capturedResult(openStep)
const assignResult = capturedResult(assignStep)
const lastResult = capturedResult(reopenStep)
const revertedCases = [openedResult, unrelatedCase]
const mutatedUnrelatedCases = [lastResult, mutatedUnrelated]
const mutatedTargetCases = [unrelatedCase, mutatedTarget]
const appendedTargetEvents = [...preparedEvents, extraTargetEvent]
const priorSubjectEvents = [...unrelatedEvents, priorSubjectEvent]
const priorSubjectHistory = [...unrelatedEvents, priorSubjectEvent, ...cleanEvents]
const wrongDetail = PayloadSchema.make({ case: assignResult, customer: customerRow, agent: offDutyRow, events: firstThreeEvents })
const wrongDetailProbe = probeRecord("case-detail", "after:assign", capturedId, wrongDetail)
const missingAuditProbe = auditProbeRecord("after", capturedId, missingAudits)
const duplicatedAuditProbe = auditProbeRecord("after", capturedId, duplicatedAudits)
const priorSubjectAuditProbe = auditProbeRecord("after", capturedId, priorSubjectAudits)
const priorlessPreparedAuditProbe = auditProbeRecord("after", targetId, preparedStepAudits)
const changedUnrelatedProbe = auditProbeRecord("after", unrelatedId, changedUnrelatedAudit)
const capturedAuditTarget = ProbeTarget.make({ probe: "audit-trail", phase: "after", subject: capturedId })
const unrelatedAuditTarget = ProbeTarget.make({ probe: "audit-trail", phase: "after", subject: unrelatedId })
const assignDetailTarget = ProbeTarget.make({ probe: "case-detail", phase: "after:assign", subject: capturedId })
const targetAuditBefore = ProbeTarget.make({ probe: "audit-trail", phase: "before", subject: targetId })
const targetAuditAfter = ProbeTarget.make({ probe: "audit-trail", phase: "after", subject: targetId })
const eventsAfter = (events: ReadonlyArray<Payload>) => afterRows("support_case_events", [...unrelatedEvents, ...events])
const interruption = Option.some("The decision model found no enabled submit action before the first lifecycle command.")
const assignTarget = (expectedVersion: number, assignedAgentId: string) => PayloadSchema.make({ caseId: targetId, expectedVersion, action: "assign", assignedAgentId })
const staleInput = assignTarget(1, onDutyAgent)
const offDutyInput = assignTarget(2, offDutyAgent)
const unassignedInput = PayloadSchema.make({ caseId: targetId, expectedVersion: 2, action: "assign" })
const resolveInput = PayloadSchema.make({ caseId: targetId, expectedVersion: 2, action: "resolve" })
const zeroInput = PayloadSchema.make({ caseId: targetId, expectedVersion: 0, action: "triage" })
const auditInput = PayloadSchema.make({ caseId: targetId })
const invalidErrorPayload = PayloadSchema.make({ message: "Expected a positive integer, got 0" })
const invalidError = Option.some(invalidErrorPayload)

const reversedDetail = PayloadSchema.make({ case: assignResult, customer: customerRow, agent: onDutyRow, events: Array.reverse(firstThreeEvents) })
const reversedDetailProbe = probeRecord("case-detail", "after:assign", capturedId, reversedDetail)
const preparedTriageEvent = Array.headNonEmpty(preparedStepEvents)
const preparedAssignEvent = Array.lastNonEmpty(preparedStepEvents)
const backdatedTriageEvent = Record.set(preparedTriageEvent, "occurredAt", "2026-10-01T08:00:00.000Z")
const backdatedPreparedEvents = [...unrelatedEvents, backdatedTriageEvent, ...openTargetEvents, preparedAssignEvent]
const raceAt = timeAt(1)
const firstRaceInput = assignTarget(2, onDutyAgent)
const secondRaceInput = assignTarget(2, secondAgent)
const secondAssignedTarget = PayloadSchema.make({ ...targetCase, status: "assigned", assignedAgentId: secondAgent, version: 3 })
const secondTargetEvent = PayloadSchema.make({ id: "0192a000-0000-7000-8000-000000000204", caseId: targetId, kind: "assigned", agentId: secondAgent, note: null, occurredAt: "2026-10-10T10:01:00.050Z" })
const winnerAuditRow = auditRow(targetId, 3, "assign", raceAt)
const raceAudit = [...targetAudit, winnerAuditRow]
const refusalPayload = flow(refusal, Option.some)
const refusalFeedback = (tag: string) => Option.some(`${tag}: the case could not be advanced.`)

const firstTiming = Exchange.make({ sentAt: "2026-10-10T10:01:00.010Z", receivedAt: "2026-10-10T10:01:00.060Z" })
const secondTiming = Exchange.make({ sentAt: "2026-10-10T10:01:00.015Z", receivedAt: "2026-10-10T10:01:00.070Z" })
const laterTiming = Exchange.make({ sentAt: "2026-10-10T10:01:00.080Z", receivedAt: "2026-10-10T10:01:00.120Z" })
const firstExchange = Option.some(firstTiming)
const secondExchange = Option.some(secondTiming)
const laterExchange = Option.some(laterTiming)

const raceAccepted = (inputCase: string, input: Payload, result: Payload) => (exchange: Option.Option<Exchange>) =>
  Submission.make({ inputCase, operation: "support.advanceCase", input, status: 200, result: Option.some(result), error: noError, at: raceAt, exchange, feedback: noFeedback })

const raceRefusedWith = (tag: string) => (inputCase: string, input: Payload) => (exchange: Option.Option<Exchange>) =>
  Submission.make({ inputCase, operation: "support.advanceCase", input, status: 422, result: noResult, error: refusalPayload(tag), at: raceAt, exchange, feedback: refusalFeedback(tag) })

const raceRefused = raceRefusedWith("VersionConflict")

const firstWon = raceAccepted("assign-first", firstRaceInput, mutatedTarget)(firstExchange)
const secondWon = raceAccepted("assign-second", secondRaceInput, secondAssignedTarget)(secondExchange)
const firstRefused = raceRefused("assign-first", firstRaceInput)(firstExchange)
const secondRefused = raceRefused("assign-second", secondRaceInput)(secondExchange)
const secondUnexchanged = raceRefused("assign-second", secondRaceInput)(noExchange)
const secondLater = raceRefused("assign-second", secondRaceInput)(laterExchange)
const secondInvalidEdge = raceRefusedWith("InvalidSupportCaseTransition")("assign-second", secondRaceInput)(secondExchange)
const secondUndocumented = raceRefusedWith("AgentOffDuty")("assign-second", secondRaceInput)(secondExchange)

const targetDetail = (phase: string, row: Payload, agent: Payload | null, events: ReadonlyArray<Payload>) => {
  const detail = PayloadSchema.make({ case: row, customer: customerRow, agent, events })

  return probeRecord("case-detail", phase, targetId, detail)
}

const wonEvents = [...targetEvents, extraTargetEvent]
const beforeTargetDetail = targetDetail("before", targetCase, null, targetEvents)
const wonDetails = [beforeTargetDetail, targetDetail("after:assign-first", mutatedTarget, onDutyRow, wonEvents), targetDetail("after", mutatedTarget, onDutyRow, wonEvents)]
const unchangedDetails = [beforeTargetDetail, targetDetail("after", targetCase, null, targetEvents)]
const firstArrival = BarrierArrival.make({ lane: "first", inputCase: "assign-first", arrivedAt: "2026-10-10T10:01:00.000Z" })
const secondArrival = BarrierArrival.make({ lane: "second", inputCase: "assign-second", arrivedAt: "2026-10-10T10:01:00.004Z" })
const releaseInstant = Option.some("2026-10-10T10:01:00.005Z")
const releasedRecord = BarrierRecord.make({ barrier: "submit", lanes: 2, arrivals: [firstArrival, secondArrival], releasedAt: releaseInstant })
const releasedBarrier = Option.some(releasedRecord)
const SubmissionControlsSchema = Schema.Array(Submission)
const ProbeControlsSchema = Schema.Array(ProbeRecord)

class RaceOutcome extends Schema.Class<RaceOutcome>("RaceOutcome")({
  submissions: SubmissionControlsSchema,
  cases: PayloadsSchema,
  events: PayloadsSchema,
  audit: PayloadsSchema,
  details: ProbeControlsSchema,
}) {}

const raceContext = (scenario: Scenario) => (outcome: RaceOutcome) => {
  const { submissions } = outcome
  const fixture = fixtureFor(scenario, targetFacts, targetTracked)
  const candidates = Array.map(scenario.inputs, candidateFor(submissions))
  const before = views(beforeView, preparedCases, preparedEvents)
  const after = views(afterView, outcome.cases, outcome.events)
  const targetBefore = auditProbeRecord("before", targetId, targetAudit)
  const targetAfter = auditProbeRecord("after", targetId, outcome.audit)
  const unrelatedBefore = auditProbeRecord("before", unrelatedId, unrelatedAudit)
  const unrelatedAfter = auditProbeRecord("after", unrelatedId, unrelatedAudit)

  return EvaluationContext.make({
    scenario,
    fixture,
    candidates,
    submissions,
    before,
    after,
    probes: [...outcome.details, targetBefore, targetAfter, unrelatedBefore, unrelatedAfter],
    directProbe: noDirectSubmission,
    barrier: releasedBarrier,
    watch: noWatch,
    interruption: noInterruption,
    evidence: [],
  })
}

const wonRace = RaceOutcome.make({ submissions: [firstWon, secondRefused], cases: mutatedTargetCases, events: appendedTargetEvents, audit: raceAudit, details: wonDetails })
const doublyAccepted = RaceOutcome.make({ submissions: [firstWon, secondWon], cases: [unrelatedCase, secondAssignedTarget], events: [...appendedTargetEvents, secondTargetEvent], audit: raceAudit, details: wonDetails })
const doublyRefused = RaceOutcome.make({ submissions: [firstRefused, secondRefused], cases: preparedCases, events: preparedEvents, audit: targetAudit, details: unchangedDetails })
const loserUnsubmitted = RaceOutcome.make({ ...wonRace, submissions: [firstWon] })
const loserUnexchanged = RaceOutcome.make({ ...wonRace, submissions: [firstWon, secondUnexchanged] })
const sequentialRace = RaceOutcome.make({ ...wonRace, submissions: [firstWon, secondLater] })
const transitionLost = RaceOutcome.make({ ...wonRace, submissions: [firstWon, secondInvalidEdge] })
const undocumentedLost = RaceOutcome.make({ ...wonRace, submissions: [firstWon, secondUndocumented] })

const raceControls = (catalog: Catalog, scenario: Scenario) => {
  const build = raceContext(scenario)
  const clean = build(wonRace)
  const pass = uniform(catalog, scenario, "pass")
  const failsRace = overriding("fail", winnerEvaluators)(pass)
  const raceUnsettled = overriding("inconclusive", winnerEvaluators)(pass)
  const allUnsettled = overriding("inconclusive", raceEvaluators)(pass)
  const twoAccepted = build(doublyAccepted)
  const bothDenied = build(doublyRefused)
  const loserPersisted = afterRows("support_cases", [unrelatedCase, secondAssignedTarget])(clean)
  const missingLoser = build(loserUnsubmitted)
  const missingExchange = build(loserUnexchanged)
  const sequential = build(sequentialRace)
  const transitionRefusal = build(transitionLost)
  const undocumentedRefusal = build(undocumentedLost)
  const failsAll = overriding("fail", raceEvaluators)(pass)
  const unbarriered = EvaluationContext.make({ ...clean, barrier: noBarrier })

  return [
    DefectCase.make({ id: "clean-race-single-winner", kind: "clean-control", context: clean, expectedStatuses: pass }),
    DefectCase.make({ id: "clean-race-transition-refusal", kind: "clean-control", context: transitionRefusal, expectedStatuses: pass }),
    DefectCase.make({ id: "race-undocumented-refusal", kind: "defect", context: undocumentedRefusal, expectedStatuses: failsAll }),
    DefectCase.make({ id: "race-two-accepted", kind: "defect", context: twoAccepted, expectedStatuses: failsRace }),
    DefectCase.make({ id: "race-both-denied", kind: "defect", context: bothDenied, expectedStatuses: failsRace }),
    DefectCase.make({ id: "race-loser-agent-persisted", kind: "defect", context: loserPersisted, expectedStatuses: failsRace }),
    DefectCase.make({ id: "race-missing-loser-submission", kind: "missing-evidence-control", context: missingLoser, expectedStatuses: allUnsettled }),
    DefectCase.make({ id: "race-missing-loser-exchange", kind: "missing-evidence-control", context: missingExchange, expectedStatuses: raceUnsettled }),
    DefectCase.make({ id: "race-sequential-exchanges", kind: "missing-evidence-control", context: sequential, expectedStatuses: raceUnsettled }),
    DefectCase.make({ id: "race-missing-barrier", kind: "missing-evidence-control", context: unbarriered, expectedStatuses: raceUnsettled }),
  ]
}

const lifecycleControls = (catalog: Catalog, scenario: Scenario) => {
  const build = lifecycleContext(scenario)
  const clean = build(cleanSteps)
  const pass = uniform(catalog, scenario, "pass")
  const failsCreation = overriding("fail", creationEvaluators)(pass)
  const failsTransitions = overriding("fail", transitionEvaluators)(pass)
  const failsHistory = overriding("fail", historyEvaluators)(pass)
  const failsChronology = overriding("fail", historyAndChronology)(pass)
  const failsDetailChronology = overriding("fail", chronologyEvaluators)(pass)
  const unwrittenUnsettled = pipe(pass, overriding("fail", creationEvaluators), overriding("inconclusive", chronologyEvaluators))
  const failsJoin = overriding("fail", joinEvaluators)(pass)
  const failsAudit = overriding("fail", auditEvaluators)(pass)
  const failsPreservation = overriding("fail", preservationEvaluators)(pass)
  const allUnsettled = overriding("inconclusive", lifecycleEvaluators)(pass)
  const joinUnsettled = overriding("inconclusive", joinEvaluators)(pass)
  const auditUnsettled = overriding("inconclusive", auditEvaluators)(pass)
  const allBlocked = overriding("blocked", lifecycleEvaluators)(pass)
  const withoutWrite = pipe(clean, afterRows("support_cases", unrelatedCases), afterRows("support_case_events", unrelatedEvents))
  const lostAfterReload = afterRows("support_cases", revertedCases)(clean)
  const skippedSteps = Array.map(cleanSteps, skippingVersion)
  const wrongStatusSteps = Array.map(cleanSteps, replacingStep("triage", wronglyAssigned))
  const uncleared = Array.map(cleanSteps, replacingStep("reopen", keptAgent))
  const offDutySteps = pipe(cleanSteps, Array.map(replacingStep("assign", offDutyAssignment)), Array.map(replacingStep("resolve", offDutyAssignment)))
  const versionSkipped = build(skippedSteps)
  const wrongStatus = build(wrongStatusSteps)
  const assignmentKept = build(uncleared)
  const offDutyAccepted = build(offDutySteps)
  const missingEvent = eventsAfter(missingEvents)(clean)
  const duplicateHistory = eventsAfter(duplicatedEvents)(clean)
  const reorderedHistory = eventsAfter(reorderedEvents)(clean)
  const reversedDetailHistory = withProbe(assignDetailTarget, reversedDetailProbe)(clean)
  const priorHistory = pipe(clean, beforeRows("support_case_events", priorSubjectEvents), afterRows("support_case_events", priorSubjectHistory))
  const wrongJoin = withProbe(assignDetailTarget, wrongDetailProbe)(clean)
  const auditMissing = withProbe(capturedAuditTarget, missingAuditProbe)(clean)
  const auditDuplicated = withProbe(capturedAuditTarget, duplicatedAuditProbe)(clean)
  const priorAudit = withProbe(capturedAuditTarget, priorSubjectAuditProbe)(clean)
  const unrelatedMutation = afterRows("support_cases", mutatedUnrelatedCases)(clean)
  const unrelatedDeletion = afterRows("support_case_events", deletedUnrelatedEvents)(clean)
  const unrelatedAuditChange = withProbe(unrelatedAuditTarget, changedUnrelatedProbe)(clean)
  const unloadedView = afterChange("support_cases", unloaded)(clean)
  const filteredView = beforeChange("support_case_events", filtered)(clean)
  const incompleteView = afterChange("support_agents", incomplete)(clean)
  const unreloadedView = afterChange("support_cases", unreloaded)(clean)
  const repeatedIdentity = afterRows("support_case_events", repeatedIdentityEvents)(clean)
  const missingDetail = withoutProbe(assignDetailTarget)(clean)
  const missingAudit = withoutProbe(capturedAuditTarget)(clean)
  const submitted = Array.take(clean.submissions, 4)
  const missingSubmission = EvaluationContext.make({ ...clean, submissions: submitted })
  const interrupted = EvaluationContext.make({ ...clean, submissions: [], interruption })

  return [
    DefectCase.make({ id: "clean-lifecycle", kind: "clean-control", context: clean, expectedStatuses: pass }),
    DefectCase.make({ id: "success-without-write", kind: "defect", context: withoutWrite, expectedStatuses: unwrittenUnsettled }),
    DefectCase.make({ id: "lost-after-reload", kind: "defect", context: lostAfterReload, expectedStatuses: failsTransitions }),
    DefectCase.make({ id: "version-skipped", kind: "defect", context: versionSkipped, expectedStatuses: failsTransitions }),
    DefectCase.make({ id: "wrong-status", kind: "defect", context: wrongStatus, expectedStatuses: failsTransitions }),
    DefectCase.make({ id: "assignment-not-cleared", kind: "defect", context: assignmentKept, expectedStatuses: failsTransitions }),
    DefectCase.make({ id: "off-duty-assignment-accepted", kind: "defect", context: offDutyAccepted, expectedStatuses: failsTransitions }),
    DefectCase.make({ id: "missing-history-event", kind: "defect", context: missingEvent, expectedStatuses: failsHistory }),
    DefectCase.make({ id: "duplicate-history-event", kind: "defect", context: duplicateHistory, expectedStatuses: failsHistory }),
    DefectCase.make({ id: "reordered-history", kind: "defect", context: reorderedHistory, expectedStatuses: failsChronology }),
    DefectCase.make({ id: "pre-existing-subject-event", kind: "defect", context: priorHistory, expectedStatuses: failsChronology }),
    DefectCase.make({ id: "detail-history-out-of-order", kind: "defect", context: reversedDetailHistory, expectedStatuses: failsDetailChronology }),
    DefectCase.make({ id: "wrong-join", kind: "defect", context: wrongJoin, expectedStatuses: failsJoin }),
    DefectCase.make({ id: "audit-missing", kind: "defect", context: auditMissing, expectedStatuses: failsAudit }),
    DefectCase.make({ id: "audit-duplicated", kind: "defect", context: auditDuplicated, expectedStatuses: failsAudit }),
    DefectCase.make({ id: "pre-existing-subject-audit", kind: "defect", context: priorAudit, expectedStatuses: failsAudit }),
    DefectCase.make({ id: "unrelated-mutation", kind: "defect", context: unrelatedMutation, expectedStatuses: failsPreservation }),
    DefectCase.make({ id: "unrelated-deletion", kind: "defect", context: unrelatedDeletion, expectedStatuses: failsPreservation }),
    DefectCase.make({ id: "unrelated-audit-changed", kind: "defect", context: unrelatedAuditChange, expectedStatuses: failsPreservation }),
    DefectCase.make({ id: "unloaded-view", kind: "missing-evidence-control", context: unloadedView, expectedStatuses: allUnsettled }),
    DefectCase.make({ id: "filtered-view", kind: "missing-evidence-control", context: filteredView, expectedStatuses: allUnsettled }),
    DefectCase.make({ id: "incomplete-view", kind: "missing-evidence-control", context: incompleteView, expectedStatuses: allUnsettled }),
    DefectCase.make({ id: "unreloaded-after-view", kind: "missing-evidence-control", context: unreloadedView, expectedStatuses: allUnsettled }),
    DefectCase.make({ id: "duplicate-row-identity", kind: "missing-evidence-control", context: repeatedIdentity, expectedStatuses: allUnsettled }),
    DefectCase.make({ id: "missing-detail-probe", kind: "missing-evidence-control", context: missingDetail, expectedStatuses: joinUnsettled }),
    DefectCase.make({ id: "missing-audit-probe", kind: "missing-evidence-control", context: missingAudit, expectedStatuses: auditUnsettled }),
    DefectCase.make({ id: "missing-submission", kind: "missing-evidence-control", context: missingSubmission, expectedStatuses: allUnsettled }),
    DefectCase.make({ id: "interrupted-before-submission", kind: "blocked-control", context: interrupted, expectedStatuses: allBlocked }),
  ]
}

const preparedControls = (catalog: Catalog, scenario: Scenario) => {
  const clean = preparedContext(scenario)(preparedSteps)
  const pass = uniform(catalog, scenario, "pass")
  const failsTransitions = overriding("fail", transitionEvaluators)(pass)
  const failsHistory = overriding("fail", historyAndPreservation)(pass)
  const failsChronology = overriding("fail", historyAndChronology)(pass)
  const failsAudit = overriding("fail", auditEvaluators)(pass)
  const startUnsettled = overriding("inconclusive", transitionEvaluators)(pass)
  const priorHistoryDeleted = afterRows("support_case_events", priorlessPreparedEvents)(clean)
  const priorAuditTruncated = withProbe(targetAuditAfter, priorlessPreparedAuditProbe)(clean)
  const startMismatch = beforeRows("support_cases", preparedCases)(clean)
  const startUnobserved = beforeRows("support_cases", unrelatedCases)(clean)
  const backdatedHistory = afterRows("support_case_events", backdatedPreparedEvents)(clean)

  return [
    DefectCase.make({ id: "clean-prepared-desk", kind: "clean-control", context: clean, expectedStatuses: pass }),
    DefectCase.make({ id: "prepared-prior-history-deleted", kind: "defect", context: priorHistoryDeleted, expectedStatuses: failsHistory }),
    DefectCase.make({ id: "prepared-prior-audit-truncated", kind: "defect", context: priorAuditTruncated, expectedStatuses: failsAudit }),
    DefectCase.make({ id: "prepared-start-mismatch", kind: "defect", context: startMismatch, expectedStatuses: failsTransitions }),
    DefectCase.make({ id: "prepared-start-unobserved", kind: "missing-evidence-control", context: startUnobserved, expectedStatuses: startUnsettled }),
    DefectCase.make({ id: "prepared-event-before-prior-history", kind: "defect", context: backdatedHistory, expectedStatuses: failsChronology }),
  ]
}

const targetControls = (catalog: Catalog, scenarios: ControlScenarios) => {
  const staleDenial = deniedAttempt(scenarios.stale, staleInput, "VersionConflict")
  const offDutyDenial = deniedAttempt(scenarios.offDuty, offDutyInput, "AgentOffDuty")
  const unassignedDenial = deniedAttempt(scenarios.unassigned, unassignedInput, "SupportAgentRequired")
  const transitionDenial = deniedAttempt(scenarios.transition, resolveInput, "InvalidSupportCaseTransition")
  const zeroRejection = attempt(scenarios.invalid, zeroInput, 400, noResult, invalidError)
  const adminRead = acceptedAttempt(scenarios.admin, auditInput, targetAudit)
  const readerDenial = deniedAttempt(scenarios.reader, auditInput, "Forbidden")
  const visitorDenial = deniedAttempt(scenarios.visitor, auditInput, "Unauthenticated")
  const wrongTag = deniedAttempt(scenarios.stale, staleInput, "AgentOffDuty")
  const staleAccepted = acceptedAttempt(scenarios.stale, staleInput, mutatedTarget)
  const zeroAccepted = acceptedAttempt(scenarios.invalid, zeroInput, targetCase)
  const readerRead = acceptedAttempt(scenarios.reader, auditInput, targetAudit)
  const truncatedRead = acceptedAttempt(scenarios.admin, auditInput, truncatedTargetAudit)
  const readerProbe = Option.some(readerDenial)
  const allowedProbe = Option.some(readerRead)
  const visitorProbe = Option.some(visitorDenial)
  const stale = targetContext(scenarios.stale, staleDenial, noDirectSubmission)
  const offDuty = targetContext(scenarios.offDuty, offDutyDenial, noDirectSubmission)
  const unassignedContext = targetContext(scenarios.unassigned, unassignedDenial, noDirectSubmission)
  const transition = targetContext(scenarios.transition, transitionDenial, noDirectSubmission)
  const invalid = targetContext(scenarios.invalid, zeroRejection, noDirectSubmission)
  const admin = targetContext(scenarios.admin, adminRead, noDirectSubmission)
  const reader = targetContext(scenarios.reader, readerDenial, readerProbe)
  const visitor = targetContext(scenarios.visitor, visitorDenial, visitorProbe)
  const deniedMutated = afterRows("support_cases", mutatedTargetCases)(stale)
  const deniedHistory = afterRows("support_case_events", appendedTargetEvents)(stale)
  const wrongDenialTag = targetContext(scenarios.stale, wrongTag, noDirectSubmission)
  const acceptedDenial = targetContext(scenarios.stale, staleAccepted, noDirectSubmission)
  const acceptedInvalid = targetContext(scenarios.invalid, zeroAccepted, noDirectSubmission)
  const auditToReader = targetContext(scenarios.reader, readerRead, readerProbe)
  const directAllowed = targetContext(scenarios.reader, readerDenial, allowedProbe)
  const auditMismatch = targetContext(scenarios.admin, truncatedRead, noDirectSubmission)
  const missingDenialProbe = withoutProbe(targetAuditBefore)(stale)
  const stalePass = uniform(catalog, scenarios.stale, "pass")
  const invalidPass = uniform(catalog, scenarios.invalid, "pass")
  const adminPass = uniform(catalog, scenarios.admin, "pass")
  const readerPass = uniform(catalog, scenarios.reader, "pass")
  const offDutyPass = uniform(catalog, scenarios.offDuty, "pass")
  const unassignedPass = uniform(catalog, scenarios.unassigned, "pass")
  const transitionPass = uniform(catalog, scenarios.transition, "pass")
  const visitorPass = uniform(catalog, scenarios.visitor, "pass")
  const failsDenial = overriding("fail", denialEvaluators)(stalePass)
  const failsDenialAndPreservation = overriding("fail", denialAndPreservation)(stalePass)
  const failsRejection = overriding("fail", rejectionAndPreservation)(invalidPass)
  const failsAuditDenialAndPreservation = overriding("fail", auditDenialAndPreservation)(readerPass)
  const failsAuditDenial = overriding("fail", auditDenialEvaluators)(readerPass)
  const failsAuditRead = overriding("fail", auditReadEvaluators)(adminPass)
  const denialUnsettled = overriding("inconclusive", denialEvaluators)(stalePass)

  return [
    DefectCase.make({ id: "clean-stale-version-denial", kind: "clean-control", context: stale, expectedStatuses: stalePass }),
    DefectCase.make({ id: "clean-off-duty-denial", kind: "clean-control", context: offDuty, expectedStatuses: offDutyPass }),
    DefectCase.make({ id: "clean-missing-assignment-denial", kind: "clean-control", context: unassignedContext, expectedStatuses: unassignedPass }),
    DefectCase.make({ id: "clean-disallowed-transition-denial", kind: "clean-control", context: transition, expectedStatuses: transitionPass }),
    DefectCase.make({ id: "clean-invalid-rejection", kind: "clean-control", context: invalid, expectedStatuses: invalidPass }),
    DefectCase.make({ id: "clean-administrator-audit", kind: "clean-control", context: admin, expectedStatuses: adminPass }),
    DefectCase.make({ id: "clean-reader-audit-denial", kind: "clean-control", context: reader, expectedStatuses: readerPass }),
    DefectCase.make({ id: "clean-visitor-audit-denial", kind: "clean-control", context: visitor, expectedStatuses: visitorPass }),
    DefectCase.make({ id: "denied-but-mutated", kind: "defect", context: deniedMutated, expectedStatuses: failsDenial }),
    DefectCase.make({ id: "denied-but-history-appended", kind: "defect", context: deniedHistory, expectedStatuses: failsDenialAndPreservation }),
    DefectCase.make({ id: "wrong-denial-tag", kind: "defect", context: wrongDenialTag, expectedStatuses: failsDenialAndPreservation }),
    DefectCase.make({ id: "accepted-where-denial-declared", kind: "defect", context: acceptedDenial, expectedStatuses: failsDenialAndPreservation }),
    DefectCase.make({ id: "invalid-input-accepted", kind: "defect", context: acceptedInvalid, expectedStatuses: failsRejection }),
    DefectCase.make({ id: "audit-returned-to-reader", kind: "defect", context: auditToReader, expectedStatuses: failsAuditDenialAndPreservation }),
    DefectCase.make({ id: "direct-probe-allowed", kind: "defect", context: directAllowed, expectedStatuses: failsAuditDenial }),
    DefectCase.make({ id: "audit-result-mismatch", kind: "defect", context: auditMismatch, expectedStatuses: failsAuditRead }),
    DefectCase.make({ id: "missing-denial-audit-probe", kind: "missing-evidence-control", context: missingDenialProbe, expectedStatuses: denialUnsettled }),
  ]
}

const withStatus = (status: Status) => (result: RequirementResult) => Equal.equals(result.status, status)
const isFailing = (status: Status) => Equal.equals(status, "fail")
const expectedOf = (statuses: ExpectedStatuses) => (result: RequirementResult) => Record.get(statuses, result.evaluator)

const expectsPass = (statuses: ExpectedStatuses, result: RequirementResult) => {
  const expected = expectedOf(statuses)(result)

  return Option.contains(expected, "pass")
}

const falselyAccepted = (statuses: ExpectedStatuses) => (result: RequirementResult) => {
  const passed = Equal.equals(result.status, "pass")
  const expectedPass = expectsPass(statuses, result)
  const unexpectedPass = !expectedPass

  return passed && unexpectedPass
}

const falselyRejected = (statuses: ExpectedStatuses) => (result: RequirementResult) => {
  const failed = Equal.equals(result.status, "fail")
  const expectedPass = expectsPass(statuses, result)

  return failed && expectedPass
}

const unexpected = (statuses: ExpectedStatuses) => (result: RequirementResult) => {
  const expected = expectedOf(statuses)(result)

  return !Option.contains(expected, result.status)
}

const evaluateWith = (context: EvaluationContext) => Effect.fn("SupportAcceptance.verifyCriterion")(function* (requirement: BoundRequirement) {
  const service = yield* RequirementEvaluation

  return yield* service.evaluate(requirement, context)
})

const verifyCase = (catalog: Catalog) => Effect.fn("SupportAcceptance.verifyDefect")(function* (defect: DefectCase, index: number) {
  const evidence = [`#/cases/${index}/observations/before`, `#/cases/${index}/observations/submissions`, `#/cases/${index}/observations/after`, `#/cases/${index}/observations/probes`]
  const context = EvaluationContext.make({ ...defect.context, evidence })
  const requirements = requirementsOf(context.scenario)(catalog)
  const results = yield* Effect.forEach(requirements, evaluateWith(context))
  const failingCriteria = Record.filter(defect.expectedStatuses, isFailing)
  const expectedFailingCriteria = Record.keys(failingCriteria)

  return VerifierCase.make({
    id: defect.id,
    kind: defect.kind,
    expectedFailingCriteria,
    expectedStatuses: defect.expectedStatuses,
    observations: context,
    results,
    falseAcceptance: Array.countBy(results, falselyAccepted(defect.expectedStatuses)),
    falseRejection: Array.countBy(results, falselyRejected(defect.expectedStatuses)),
    unexpectedStatuses: Array.countBy(results, unexpected(defect.expectedStatuses)),
    blocked: Array.countBy(results, withStatus("blocked")),
    inconclusive: Array.countBy(results, withStatus("inconclusive")),
  })
})

type CountKey = "falseAcceptance" | "falseRejection" | "unexpectedStatuses" | "blocked" | "inconclusive"

const total = (cases: ReadonlyArray<VerifierCase>, key: CountKey) => pipe(cases, Array.map(Struct.get(key)), Number.sumAll)
const criteriaOf = (verified: VerifierCase) => Array.length(verified.results)
const isMissingEvidenceControl = (verified: VerifierCase) => Equal.equals(verified.kind, "missing-evidence-control")
const invalidCatalog = (error: Schema.SchemaError) => AcceptanceError.make({ boundary: "verifier", message: error.message })
const decodeCatalog = Schema.decodeUnknownEffect(Catalog)

const scenarioById = (catalog: Catalog) => (id: string) => {
  const missing = AcceptanceError.make({ boundary: "verifier", message: `The catalog has no ${id} scenario.` })

  return pipe(catalog.scenarios, Array.findFirst(byId(id)), Effect.fromOption, Effect.mapError(Function.constant(missing)))
}

const controlScenarios = Effect.fn("SupportAcceptance.controlScenarios")(function* (catalog: Catalog) {
  const find = scenarioById(catalog)
  const lifecycle = yield* find("case-lifecycle")
  const desk = yield* find("desk-triage-assign")
  const stale = yield* find("stale-version-denied")
  const offDuty = yield* find("off-duty-denied")
  const unassignedScenario = yield* find("missing-assignment-denied")
  const transition = yield* find("disallowed-transition-denied")
  const invalid = yield* find("invalid-version-rejected")
  const admin = yield* find("audit-admin")
  const reader = yield* find("audit-reader-denied")
  const visitor = yield* find("audit-visitor-denied")
  const race = yield* find("race-round-1")

  return ControlScenarios.make({ lifecycle, desk, stale, offDuty, unassigned: unassignedScenario, transition, invalid, admin, reader, visitor, race })
})

export const verifyDefects = Effect.fn("SupportAcceptance.verifyDefects")(function* () {
  const catalog = yield* pipe(supportCasesCatalog, decodeCatalog, Effect.mapError(invalidCatalog))
  const scenarios = yield* controlScenarios(catalog)
  const lifecycle = lifecycleControls(catalog, scenarios.lifecycle)
  const prepared = preparedControls(catalog, scenarios.desk)
  const targets = targetControls(catalog, scenarios)
  const races = raceControls(catalog, scenarios.race)
  const controls = [...lifecycle, ...prepared, ...targets, ...races]
  const cases = yield* Effect.forEach(controls, verifyCase(catalog))
  const criteria = pipe(cases, Array.map(criteriaOf), Number.sumAll)

  const summary = VerifierSummary.make({
    cases: Array.length(cases),
    criteria,
    falseAcceptance: total(cases, "falseAcceptance"),
    falseRejection: total(cases, "falseRejection"),
    unexpectedStatuses: total(cases, "unexpectedStatuses"),
    blocked: total(cases, "blocked"),
    inconclusive: total(cases, "inconclusive"),
    missingEvidenceControls: Array.countBy(cases, isMissingEvidenceControl),
  })

  return VerifierReport.make({
    revision: "1",
    basis: "executable assertion",
    evidenceSource: "deliberately constructed observation controls; not browser or model execution",
    cases,
    summary,
  })
}, Effect.provide(evaluationLayer))()
