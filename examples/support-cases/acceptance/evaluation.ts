import { Array, DateTime, Effect, Equal, Function, HashMap, HashSet, Layer, Number, Option, Predicate, Record, Schema, String, Struct, flow, pipe } from "effect"
import type { ParseOptions } from "effect/SchemaAST"
import { Resource } from "effect-domains/resource"
import { SupportCasesApplication } from "../application.ts"
import { SupportCaseAuditsResource } from "../audit.ts"
import { SupportCaseDetail } from "../contracts.ts"
import { AdvanceSupportCaseInputSchema, OpenSupportCaseInputSchema, type SupportAgent, SupportCaseTransitions } from "../domain.ts"
import { SupportAgentsResource, SupportCaseEventsResource, SupportCasesResource } from "../resources.ts"
import { AcceptanceError, DeniedSchema, type EvaluationContext, type InputCase, type Observation, PayloadSchema, type ProbeRecord, ProbeTarget, type Payload, type Requirement, RequirementEvaluation, RequirementResult, ResultStatusSchema, type Submission } from "@effect-domains/acceptance/model"

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

const deniedLabels = flow(deniedLabel, Array.of)
const outcomeList = Array.join(" or ")

const declaredOutcomes = (input: InputCase): ReadonlyArray<string> => {
  const { outcome } = input

  return isDenied(outcome) ? deniedLabels(outcome.failure) : Array.of(outcome.kind)
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

const onDutyWith = (id: string) => (agent: SupportAgent) => {
  const same = Equal.equals(agent.id, id)

  return same && agent.onDuty
}

const isOnDuty = (agents: ReadonlyArray<SupportAgent>, id: string | null) => Predicate.isNotNull(id) && Array.some(agents, onDutyWith(id))
const problemAt = (inputCase: string) => (field: string) => `${inputCase}: ${field}`

const transitionProblems = (agents: ReadonlyArray<SupportAgent>) => ([prior, step]: readonly [CaseRow, Step]) => {
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
const agentFor = (id: string | null) => (agents: ReadonlyArray<SupportAgent>) => Predicate.isNull(id) ? unassigned : Array.findFirst(agents, byId(id))
const customerIdFact = textFact("customer.id")
const customerNameFact = textFact("customer.name")
const missingCustomer = blocking("The fixture does not declare customer.id and customer.name.")

const joinCheck = (context: EvaluationContext, agents: ReadonlyArray<SupportAgent>, priorCount: number) => Effect.fn("SupportAcceptance.joinCheck")(function* (step: Step, index: number) {
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

  const direct = yield* pipe(context.directProbes, Array.findFirst(isAuditRead), present(noDirectProbe))
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

const evaluators = HashMap.make<ReadonlyArray<readonly [string, (context: EvaluationContext) => Verdict<Assertion>]>>(
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
)

export const evaluatorNames: ReadonlyArray<string> = pipe(evaluators, HashMap.keys, Array.fromIterable)

const resultFor = (requirement: Requirement, context: EvaluationContext) => (verdict: Assertion) => RequirementResult.make({
  requirement: requirement.id,
  scenario: context.scenario.id,
  evaluator: requirement.evaluator,
  status: verdict.status,
  explanation: verdict.explanation,
  evidence: context.evidence,
})

const evaluate = Effect.fn("SupportAcceptance.evaluate")(function* (requirement: Requirement, context: EvaluationContext) {
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
