import { Equal } from "effect"
import type { Catalog } from "@effect-domains/acceptance/model"

type Declaration = typeof Catalog.Encoded
type ScenarioDeclaration = Declaration["scenarios"][number]
type InputDeclaration = ScenarioDeclaration["inputs"][number]
type FieldDeclaration = InputDeclaration["fields"][string]

const fixtureFact = (fact: string, offset: number): FieldDeclaration => ({ source: "fixture", fact, offset })
const captured = (field: string): FieldDeclaration => ({ source: "captured", field, offset: 0 })
const literal = (value: unknown): FieldDeclaration => ({ source: "literal", value })
const nativeSample: FieldDeclaration = { source: "native", strategy: "sample" }
const accepted: InputDeclaration["outcome"] = { kind: "accepted" }
const rejected: InputDeclaration["outcome"] = { kind: "rejected" }
const denied = (failure: string): InputDeclaration["outcome"] => ({ kind: "denied", failure })
const customer = fixtureFact("customer.id", 0)
const onDutyAgent = fixtureFact("agent.on-duty.id", 0)
const offDutyAgent = fixtureFact("agent.off-duty.id", 0)
const targetId = fixtureFact("target.id", 0)
const targetVersion = fixtureFact("target.version", 0)
const staleTargetVersion = fixtureFact("target.version", -1)
const capturedId = captured("id")
const capturedVersion = captured("version")
const triageAction = literal("triage")
const assignAction = literal("assign")
const resolveAction = literal("resolve")
const reopenAction = literal("reopen")
const zeroVersion = literal(0)
const forbidden = denied("Forbidden")
const unauthenticated = denied("Unauthenticated")
const subjectText = literal("Cannot export quarterly report")
const triageNote = literal("Reproduced from the export payload.")
const resolveNote = literal("Export permission repaired.")
const reopenNote = literal("The customer reports the quarterly export failing again.")

const lifecycleInput = (id: string, operation: string, description: string, fields: InputDeclaration["fields"]): InputDeclaration => ({
  id,
  operation,
  description,
  fields,
  validity: "native-valid",
  outcome: accepted,
})

const capturedAdvance = (id: string, description: string, action: FieldDeclaration, detail: InputDeclaration["fields"]) =>
  lifecycleInput(id, "support.advanceCase", description, { caseId: capturedId, expectedVersion: capturedVersion, action, ...detail })

const openInput = lifecycleInput("open", "support.openCase", "Open a case for the prepared customer with the reported subject", { customerId: customer, subject: subjectText, priority: nativeSample })
const triageInput = capturedAdvance("triage", "Triage the opened case at its current version with the reproduction note", triageAction, { note: triageNote })
const assignInput = capturedAdvance("assign", "Assign the triaged case at its current version to the on-duty agent", assignAction, { assignedAgentId: onDutyAgent })
const resolveInput = capturedAdvance("resolve", "Resolve the assigned case at its current version with the repair note", resolveAction, { note: resolveNote })
const reopenInput = capturedAdvance("reopen", "Reopen the resolved case at its current version with the customer's follow-up note", reopenAction, { note: reopenNote })

const attemptInput = (id: string, description: string, fields: InputDeclaration["fields"], outcome: InputDeclaration["outcome"]): InputDeclaration => {
  const invalid = Equal.equals(outcome.kind, "rejected")

  return {
    id,
    operation: "support.advanceCase",
    description,
    fields,
    validity: invalid ? "native-invalid" : "native-valid",
    outcome,
  }
}

const targetAttempt = (id: string, description: string, version: FieldDeclaration, action: FieldDeclaration, detail: InputDeclaration["fields"], outcome: InputDeclaration["outcome"]) =>
  attemptInput(id, description, { caseId: targetId, expectedVersion: version, action, ...detail }, outcome)

const staleAssignOutcome = denied("VersionConflict")
const offDutyOutcome = denied("AgentOffDuty")
const unassignedOutcome = denied("SupportAgentRequired")
const invalidTransitionOutcome = denied("InvalidSupportCaseTransition")
const staleAssignInput = targetAttempt("stale-assign", "Assign the prepared case to the on-duty agent using its previous, stale version", staleTargetVersion, assignAction, { assignedAgentId: onDutyAgent }, staleAssignOutcome)
const offDutyInput = targetAttempt("off-duty-assign", "Assign the prepared case at its current version to the off-duty agent", targetVersion, assignAction, { assignedAgentId: offDutyAgent }, offDutyOutcome)
const unassignedInput = targetAttempt("unassigned-assign", "Assign the prepared case at its current version without an agent", targetVersion, assignAction, {}, unassignedOutcome)
const resolveOpenInput = targetAttempt("resolve-open", "Resolve the prepared open case at its current version", targetVersion, resolveAction, {}, invalidTransitionOutcome)
const zeroVersionInput = targetAttempt("zero-version-triage", "Triage the prepared open case with expected version 0", zeroVersion, triageAction, {}, rejected)

const auditInput = (outcome: InputDeclaration["outcome"]): InputDeclaration => ({
  id: "read-audit",
  operation: "support.auditTrail",
  description: "Read the lifecycle audit trail of the prepared case",
  fields: { caseId: targetId },
  validity: "native-valid",
  outcome,
})

const adminAuditInput = auditInput(accepted)
const readerAuditInput = auditInput(forbidden)
const visitorAuditInput = auditInput(unauthenticated)
const lifecycleObservations = ["support_cases", "support_case_events", "support_agents", "support_customers"]
const lifecycleRequirements = ["SC-OPEN", "SC-LIFECYCLE", "SC-HISTORY", "SC-JOIN", "SC-AUDIT", "SC-PRESERVE"]
const denialRequirements = ["SC-DENY", "SC-PRESERVE"]
const rejectionRequirements = ["SC-REJECT", "SC-PRESERVE"]
const auditReadRequirements = ["SC-AUDIT-READ", "SC-PRESERVE"]
const auditDenyRequirements = ["SC-AUDIT-DENY", "SC-PRESERVE"]
const auditGoal = "Open the audit trail operation and request the lifecycle audit for the prepared case with the offered input, then reload the page. Do not change any case."

const attemptScenario = (id: string, fixture: string, goal: string, input: InputDeclaration, requirements: ReadonlyArray<string>): ScenarioDeclaration => ({
  id,
  story: "protect-lifecycle-integrity",
  actor: "operator",
  fixture,
  goal,
  operations: ["support.advanceCase"],
  inputs: [input],
  required: [input.id],
  observations: lifecycleObservations,
  probes: ["case-detail", "audit-trail"],
  requirements,
  reload: true,
})

const auditScenario = (id: string, story: string, actor: string, input: InputDeclaration, requirements: ReadonlyArray<string>): ScenarioDeclaration => ({
  id,
  story,
  actor,
  fixture: "support-target-triaged",
  goal: auditGoal,
  operations: ["support.auditTrail"],
  inputs: [input],
  required: [input.id],
  observations: lifecycleObservations,
  probes: ["audit-trail"],
  requirements,
  reload: true,
})

const lifecycleScenario: ScenarioDeclaration = {
  id: "case-lifecycle",
  story: "resolve-customer-problem",
  actor: "operator",
  fixture: "support-baseline",
  goal: "Open a case for the prepared customer, then triage it, assign it to the on-duty agent, resolve it, and reopen it, using the offered candidate inputs in that order. After the last command, reload the page.",
  operations: ["support.openCase", "support.advanceCase"],
  inputs: [openInput, triageInput, assignInput, resolveInput, reopenInput],
  required: ["open", "triage", "assign", "resolve", "reopen"],
  observations: lifecycleObservations,
  probes: ["case-detail", "audit-trail"],
  requirements: lifecycleRequirements,
  reload: true,
}

const scenarios: Declaration["scenarios"] = [
  lifecycleScenario,
  attemptScenario("stale-version-denied", "support-target-triaged", "Enter and submit the offered stale-version assignment of the prepared triaged case through the Advance case form so that the application's refusal is observed, then reload the page.", staleAssignInput, denialRequirements),
  attemptScenario("off-duty-denied", "support-target-triaged", "Enter and submit the offered assignment of the prepared triaged case to the off-duty agent through the Advance case form so that the application's refusal is observed, then reload the page.", offDutyInput, denialRequirements),
  attemptScenario("missing-assignment-denied", "support-target-triaged", "Enter and submit the offered assignment of the prepared triaged case without an agent through the Advance case form so that the application's refusal is observed, then reload the page.", unassignedInput, denialRequirements),
  attemptScenario("disallowed-transition-denied", "support-target-open", "Enter and submit the offered resolution of the prepared open case through the Advance case form so that the application's refusal of that transition is observed, then reload the page.", resolveOpenInput, denialRequirements),
  attemptScenario("invalid-version-rejected", "support-target-open", "Enter and submit the offered triage of the prepared open case with expected version 0 through the Advance case form so that the application's rejection of input outside the native contract is observed, then reload the page.", zeroVersionInput, rejectionRequirements),
  auditScenario("audit-admin", "review-audit-trail", "administrator", adminAuditInput, auditReadRequirements),
  auditScenario("audit-reader-denied", "audit-withheld-from-reader", "reader", readerAuditInput, auditDenyRequirements),
  auditScenario("audit-visitor-denied", "audit-withheld-from-visitor", "visitor", visitorAuditInput, auditDenyRequirements),
]

const requirements: Declaration["requirements"] = [
  { id: "SC-OPEN", text: "Opening a case for an existing customer creates exactly one open, unassigned case at version 1 with the submitted subject and priority.", evaluator: "opened-case" },
  { id: "SC-LIFECYCLE", text: "Each accepted lifecycle command follows the native transition graph, advances the version by exactly one, assigns only the submitted on-duty agent, and reopening clears the assignment; the final state survives reload.", evaluator: "lifecycle-transitions" },
  { id: "SC-HISTORY", text: "The case history holds exactly one ordered event per accepted lifecycle command, with the submitted notes and the agent assigned after that command.", evaluator: "ordered-history" },
  { id: "SC-JOIN", text: "After every accepted command, the case detail joins the current customer and the currently assigned agent, or no agent when unassigned.", evaluator: "joined-detail" },
  { id: "SC-AUDIT", text: "Every accepted lifecycle command appends exactly one succeeded audit record for its case version, readable through the administrator binding.", evaluator: "audit-recorded" },
  { id: "SC-PRESERVE", text: "Unrelated cases, their history and audit records, customers, and agents remain exactly unchanged.", evaluator: "unrelated-unchanged" },
  { id: "SC-DENY", text: "A native-valid lifecycle attempt that violates version, duty, assignment, or transition policy fails with the declared native failure and leaves the case, its history, and its audit trail unchanged.", evaluator: "denied-unchanged" },
  { id: "SC-REJECT", text: "A lifecycle input outside the native contract is rejected before execution and leaves every record unchanged.", evaluator: "invalid-rejected" },
  { id: "SC-AUDIT-READ", text: "An administrator reads exactly the recorded lifecycle audit of the requested case.", evaluator: "audit-authorized" },
  { id: "SC-AUDIT-DENY", text: "Audit evidence is withheld from readers without the administrator role and from visitors without a session, enforced by the server.", evaluator: "audit-denied" },
]

const actors: Declaration["actors"] = [
  { id: "operator", binding: "public-operator", description: "A support operator using the public lifecycle commands; the application grants these commands publicly, so no credentials are bound." },
  { id: "administrator", binding: "admin-session", description: "The seeded administrator account; the harness resolves its session, which is never model-visible." },
  { id: "reader", binding: "reader-session", description: "The seeded reader account without the administrator role." },
  { id: "visitor", binding: "anonymous", description: "A visitor with no session." },
]

const stories: Declaration["stories"] = [
  { id: "resolve-customer-problem", text: "As a support operator, I want to open a customer's case and move it through triage, assignment to an available agent, resolution, and reopening so that the problem is tracked with accountable history.", actor: "operator", requirements: lifecycleRequirements },
  { id: "protect-lifecycle-integrity", text: "As a support operator, I want conflicting or invalid lifecycle attempts refused without changing the case so that concurrent work and duty rules are respected.", actor: "operator", requirements: ["SC-DENY", "SC-REJECT", "SC-PRESERVE"] },
  { id: "review-audit-trail", text: "As an administrator, I want to read a case's lifecycle audit so that I can account for every change.", actor: "administrator", requirements: auditReadRequirements },
  { id: "audit-withheld-from-reader", text: "As a reader without administrator rights, I cannot read audit evidence, so that lifecycle accountability stays restricted to administrators.", actor: "reader", requirements: auditDenyRequirements },
  { id: "audit-withheld-from-visitor", text: "As a visitor without a session, I cannot read audit evidence.", actor: "visitor", requirements: auditDenyRequirements },
]

export const supportCasesCatalog: Declaration = {
  id: "support-cases",
  actors,
  requirements,
  stories,
  scenarios,
}
