import { Database } from "bun:sqlite"
import { Effect, Equal, Function, HashMap, Number, Option, Record, Ref, Schema, Struct, flow, pipe } from "effect"
import { FaultDeclaration, ProxyCall, Reply, answer, delayedCalls, fixtureFact, fixtureProbe, racingSubmitScript, realCall, replyOf, scripted, type Fault, type FaultBehavior, type FaultContext, type Forward, type ProxyResponse } from "@effect-domains/acceptance/faults"
import { AcceptanceError, PayloadSchema, type Payload } from "@effect-domains/acceptance/model"
import { SupportCaseTransitions } from "../domain.ts"

const faultError = (message: string) => AcceptanceError.make({ boundary: "fault", message })

const describeFault = flow(String, faultError)

const withinSuccess = Number.between({ minimum: 200, maximum: 299 })

const isPayload = Schema.is(PayloadSchema)

const callsTo = (operation: string) => (request: ProxyCall): boolean => Equal.equals(request.operation, operation)

const advanceCall = callsTo("support.advanceCase")

const openCall = callsTo("support.openCase")

const auditCall = callsTo("support.auditTrail")

const actionOf = (request: ProxyCall) => pipe(request.input, Record.get("action"), Option.filter(Schema.is(Schema.String)))

const advancing = (action: string) => (request: ProxyCall): boolean => {
  const advance = advanceCall(request)
  const requestedAction = actionOf(request)
  const requested = Option.contains(requestedAction, action)

  return advance && requested
}

const assigning = advancing("assign")

const resolving = advancing("resolve")

const caseOf = (request: ProxyCall) => pipe(request.input, Record.get("caseId"), Option.filter(Schema.is(Schema.String)))

const missingCase = faultError("The intercepted call names no case")

const requestedCase = flow(caseOf, Effect.fromOption, Effect.mapError(Function.constant(missingCase)))

const decided = (call: FaultBehavior["call"], document: FaultBehavior["document"]): FaultBehavior => ({ call, document })

const callsOnly = (decide: (context: FaultContext) => FaultBehavior["call"]) => Effect.fn("SupportFaults.callsOnly")(function* (context: FaultContext) {
  const call = decide(context)
  const behavior = decided(call, Effect.succeedNone)

  return yield* Effect.succeed(behavior)
})

const policyDenial = Number.between({ minimum: 422, maximum: 422 })

// The real denial is returned because a denied-but-mutating defect must look refused while still assigning the case.
const mutateOnDenial = (context: FaultContext) => Effect.fn("SupportFaults.mutateOnDenial")(function* (request: ProxyCall, forward: Forward) {
  const response = yield* forward(request)
  const denied = policyDenial(response.status)
  const mutating = assigning(request) && denied

  if (!mutating) return response

  const agent = yield* fixtureFact(context, "agent.on-duty.id", Schema.String)
  const input = PayloadSchema.make({ ...request.input, assignedAgentId: agent })

  yield* realCall(context, "support.advanceCase", input)

  return response
})

const deleteTriaged = "DELETE FROM support_case_events WHERE \"caseId\" = ? AND \"kind\" = 'triaged'"

const openDatabase = (path: string) => Effect.try({ try: () => new Database(path), catch: describeFault })

const closeDatabase = (database: Database) => Effect.sync(() => database.close())

const deleteHistory = (caseId: string) => (database: Database) => Effect.try({ try: () => database.run(deleteTriaged, [caseId]), catch: describeFault })

// History is deleted from the isolated store after the real resolve because a history-deleting defect loses accepted events silently.
const eraseHistory = (context: FaultContext) => Effect.fn("SupportFaults.eraseHistory")(function* (request: ProxyCall, forward: Forward) {
  const response = yield* forward(request)
  const accepted = withinSuccess(response.status)
  const erasing = resolving(request) && accepted

  if (!erasing) return response

  const caseId = yield* requestedCase(request)
  const path = yield* fixtureFact(context, "application.database", Schema.String)
  const opened = openDatabase(path)
  const outcome = yield* Effect.acquireUseRelease(opened, deleteHistory(caseId), closeDatabase)

  yield* context.record(`deleted ${outcome.changes} triaged event row(s) of case ${caseId} from the isolated application store`)

  return response
})

const assignTransition = Record.get(SupportCaseTransitions.transitions, "assign")

const assignedStatus = pipe(assignTransition, Option.map(Struct.get("to")), Option.getOrNull)

const fabricatedAssignment = (row: Payload, request: ProxyCall, version: number) => {
  const agent = Record.get(request.input, "assignedAgentId")

  return PayloadSchema.make({
    ...row,
    status: assignedStatus,
    assignedAgentId: Option.getOrNull(agent),
    version: version + 1,
  })
}

const unobservedMessage = (caseId: string) => `No lifecycle result of case ${caseId} was observed before the assignment`

const unobserved = flow(unobservedMessage, faultError, Function.constant)

const observedRow = (rows: HashMap.HashMap<string, Payload>, caseId: string) => pipe(HashMap.get(rows, caseId), Effect.fromOption, Effect.mapError(unobserved(caseId)))

const caseRowOf = flow(Struct.get<Reply, "result">("result"), Option.filter(isPayload))

const rowCase = (row: Payload) => pipe(row, Record.get("id"), Option.filter(Schema.is(Schema.String)))

const remember = (rows: Ref.Ref<HashMap.HashMap<string, Payload>>) => Effect.fn("SupportFaults.remember")(function* (response: ProxyResponse) {
  const reply = yield* replyOf(response)
  const row = caseRowOf(reply)
  const id = Option.flatMap(row, rowCase)
  const observed = Option.all({ id, row })

  if (Option.isSome(observed)) yield* Ref.update(rows, HashMap.set(observed.value.id, observed.value.row))
})

const noError = Option.none<unknown>()

const decodeVersion = Schema.decodeUnknownEffect(Schema.Int)

// The assignment is answered here because a success-without-write defect reports the new state while storing nothing.
const fabricatedReply = Effect.fn("SupportFaults.fabricatedReply")(function* (context: FaultContext, rows: Ref.Ref<HashMap.HashMap<string, Payload>>, request: ProxyCall) {
  const caseId = yield* requestedCase(request)
  const observed = yield* Ref.get(rows)
  const row = yield* observedRow(observed, caseId)
  const version = yield* pipe(row, Record.get("version"), Option.getOrUndefined, decodeVersion, Effect.mapError(describeFault))
  const fabricated = fabricatedAssignment(row, request, version)
  const result = Option.some(fabricated)
  const reply = Reply.make({ result, error: noError })

  yield* context.record(`answered the assign of case ${caseId} with fabricated version ${version + 1} without forwarding`)

  return yield* answer(200, reply)
})

const fabricateAssignment = (context: FaultContext, rows: Ref.Ref<HashMap.HashMap<string, Payload>>) => Effect.fn("SupportFaults.fabricateAssignment")(function* (request: ProxyCall, forward: Forward) {
  if (assigning(request)) return yield* fabricatedReply(context, rows, request)

  const response = yield* forward(request)
  const lifecycle = advanceCall(request) || openCall(request)
  const accepted = withinSuccess(response.status)
  const observing = lifecycle && accepted

  if (observing) yield* remember(rows)(response)

  return response
})

const emptyRows = HashMap.empty<string, Payload>()

const assignWithoutWrite = Effect.fn("SupportFaults.assignWithoutWrite")(function* (context: FaultContext) {
  const rows = yield* Ref.make(emptyRows)
  const call = fabricateAssignment(context, rows)

  return decided(call, Effect.succeedNone)
})

// The reader is answered with the administrator probe's real records because an audit-leaking defect bypasses the role check.
const leakAudit = (context: FaultContext) => Effect.fn("SupportFaults.leakAudit")(function* (request: ProxyCall, forward: Forward) {
  if (!auditCall(request)) return yield* forward(request)

  const caseId = yield* requestedCase(request)
  const record = yield* fixtureProbe(context, "audit-trail", caseId)
  const reply = Reply.make({ result: record.result, error: noError })

  yield* context.record(`answered the reader's support.auditTrail for case ${caseId} with the administrator's records`)

  return yield* answer(200, reply)
})

const noOverride = Option.none<number>()

// Defects share one declaration shape because only their identity, story, and affected requirement differ.
const defectiveImplementation = (id: string, label: string, description: string, scenario: string, affected: ReadonlyArray<string>) => FaultDeclaration.make({
  id,
  label: `Defective implementation: ${label}`,
  description,
  kind: "defective-implementation",
  scenario,
  affected,
  deadlineSeconds: noOverride,
  maxActions: noOverride,
})

const denyButMutateDeclaration = defectiveImplementation("deny-but-mutate", "denied assignment still mutates", "The off-duty assignment keeps its real 422 AgentOffDuty denial, but a valid assignment of the target to the on-duty agent is also stored.", "off-duty-denied", ["SC-DENY"])

const historyDeletionDeclaration = defectiveImplementation("history-deletion", "history deletion", "After the real resolve is stored, the case's triaged event row is deleted from the isolated application SQLite store.", "case-lifecycle", ["SC-HISTORY"])

const assignWithoutWriteDeclaration = defectiveImplementation("assign-without-write", "assignment without write", "The assign advance is answered with a fabricated success (the submitted agent applied to the last observed case row at version + 1) and never reaches the application.", "case-lifecycle", ["SC-LIFECYCLE"])

const auditLeakDeclaration = defectiveImplementation("audit-leak", "audit leak", "The reader's support.auditTrail is answered with the real records read through the fixture's administrator audit probe.", "audit-reader-denied", ["SC-AUDIT-DENY"])

const denyButMutate: Fault = { declaration: denyButMutateDeclaration, behavior: callsOnly(mutateOnDenial) }

const historyDeletion: Fault = { declaration: historyDeletionDeclaration, behavior: callsOnly(eraseHistory) }

const assignmentWithoutWrite: Fault = { declaration: assignWithoutWriteDeclaration, behavior: assignWithoutWrite }

const auditLeak: Fault = { declaration: auditLeakDeclaration, behavior: callsOnly(leakAudit) }

const racingTarget: Fault = {
  declaration: FaultDeclaration.make({
    id: "racing-target",
    label: "Execution control: racing target",
    description: "An injected script mutates the active form's submit button attributes every 250 ms, so offered browser snapshots go stale before they can be executed.",
    kind: "execution-control",
    scenario: "stale-version-denied",
    affected: [],
    deadlineSeconds: noOverride,
    maxActions: noOverride,
  }),
  behavior: scripted("racing-submit", racingSubmitScript),
}

const deadline: Fault = {
  declaration: FaultDeclaration.make({
    id: "deadline",
    label: "Execution control: deadline",
    description: "Every public call is delayed by 5 seconds while the scenario deadline is 15 seconds, so the five-command lifecycle must stop at its deadline without passing any criterion.",
    kind: "execution-control",
    scenario: "case-lifecycle",
    affected: [],
    deadlineSeconds: Option.some(15),
    maxActions: noOverride,
  }),
  behavior: delayedCalls("5 seconds"),
}

// Identities are swapped on every render because a wrong-target control must offer rows whose bound identity names another case.
const swappedCaseIdsScript = `(() => {
  const swap = () => {
    const rows = Array.from(document.querySelectorAll("tr[data-case-id]:not([data-acceptance-swapped])"))
    if (rows.length < 2) return
    const ids = rows.map((row) => row.getAttribute("data-case-id"))
    rows.forEach((row, index) => {
      row.setAttribute("data-case-id", ids[(index + 1) % ids.length])
      row.setAttribute("data-acceptance-swapped", "true")
    })
  }
  new MutationObserver(swap).observe(document, { subtree: true, childList: true })
})()
`

const deskWrongTarget: Fault = {
  declaration: FaultDeclaration.make({
    id: "desk-wrong-target",
    label: "Execution control: desk wrong target",
    description: "An injected script rotates the data-case-id attributes of the support desk rows on every render, so each row's bound identity names another case than its rendered id column; no row action may be offered or repaired onto another case.",
    kind: "execution-control",
    scenario: "desk-triage-assign",
    affected: [],
    deadlineSeconds: noOverride,
    maxActions: noOverride,
  }),
  behavior: scripted("desk-wrong-target", swappedCaseIdsScript),
}

/** Support Cases' labeled defective implementations and execution controls, each injected only into its isolated owned application. */
export const supportCasesFaults: ReadonlyArray<Fault> = [denyButMutate, historyDeletion, assignmentWithoutWrite, auditLeak, racingTarget, deadline, deskWrongTarget]
