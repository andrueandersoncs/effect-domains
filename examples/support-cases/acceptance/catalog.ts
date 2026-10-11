import { Array, Equal, Function, HashMap, Option, Predicate } from "effect"
import { type Catalog, type Requirement, type Revision, qualified } from "@effect-domains/acceptance/model"

const provenance = "docs/wiki/story-driven-acceptance.md#slice-b-support-cases"
const versionPolicy = "examples/support-cases/README.md#resolve-and-inspect-history"
const historyPolicy = "examples/support-cases/README.md#resolve-and-inspect-history; #open-and-query-a-case; #use-the-application-ui-or-mcp"
const reviewProposal = "docs/wiki/story-driven-acceptance.md#ap-15; proposed by the implementation agent for product review"
const revision = "1"
const attemptRevision = "2"
const catalogRevision = "7"
const revisedRaceCatalogRevision = "6"
const recordedCatalogRevision = "5"
const raceRevision = "2"
const deskCatalogRevision = "4"
const structuredCatalogRevision = "3"
const preparedSubjectRevision = "2"
const chronologyRevision = "2"
const assessedRevision = "3"
const correctedNarrativeRevision = "3"
const catalogId = "support-cases-slice-b"
const approval = "approved"

type Declaration = typeof Catalog.Encoded
type ScenarioDeclaration = Declaration["scenarios"][number]
type InputDeclaration = ScenarioDeclaration["inputs"][number]
type FieldDeclaration = InputDeclaration["fields"][string]

const fixtureFact = (fact: string, offset: number): FieldDeclaration => ({ source: "fixture", fact, offset })
const captured = (field: string): FieldDeclaration => ({ source: "captured", field, offset: 0 })
const text = (field: string): FieldDeclaration => ({ source: "text", fixture: "case-report", field })
const literal = (value: unknown): FieldDeclaration => ({ source: "literal", value })
const nativeSample: FieldDeclaration = { source: "native", strategy: "sample" }
const accepted: InputDeclaration["outcome"] = { kind: "accepted" }
const rejected: InputDeclaration["outcome"] = { kind: "rejected" }
const denied = (failure: string): InputDeclaration["outcome"] => ({ kind: "denied", failure })
const customer = fixtureFact("customer.id", 0)
const onDutyAgent = fixtureFact("agent.on-duty.id", 0)
const secondOnDutyAgent = fixtureFact("agent.second-on-duty.id", 0)
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

const lifecycleInput = (id: string, operation: string, description: string, fields: InputDeclaration["fields"]): InputDeclaration => ({
  id,
  operation,
  description,
  fields,
  validity: "native-valid",
  outcome: accepted,
})

const subjectText = text("subject")
const triageNote = text("triageNote")
const resolveNote = text("resolveNote")
const reopenNote = text("reopenNote")

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

const staleAssignOutcome = denied("VersionConflict")
const offDutyOutcome = denied("AgentOffDuty")
const unassignedOutcome = denied("SupportAgentRequired")
const invalidTransitionOutcome = denied("InvalidSupportCaseTransition")
// The loser may meet either refusal because both are documented and neither the README nor the domain documents which one a same-version loser meets first.
const contendedOutcome: InputDeclaration["outcome"] = { kind: "contended", failures: ["VersionConflict", "InvalidSupportCaseTransition"] }

const targetAttempt = (id: string, description: string, version: FieldDeclaration, action: FieldDeclaration, detail: InputDeclaration["fields"], outcome: InputDeclaration["outcome"]) =>
  attemptInput(id, description, { caseId: targetId, expectedVersion: version, action, ...detail }, outcome)

const staleAssignInput = targetAttempt("stale-assign", "Assign the prepared case to the on-duty agent using its previous, stale version", staleTargetVersion, assignAction, { assignedAgentId: onDutyAgent }, staleAssignOutcome)
const offDutyInput = targetAttempt("off-duty-assign", "Assign the prepared case at its current version to the off-duty agent", targetVersion, assignAction, { assignedAgentId: offDutyAgent }, offDutyOutcome)
const unassignedInput = targetAttempt("unassigned-assign", "Assign the prepared case at its current version without an agent", targetVersion, assignAction, {}, unassignedOutcome)
const resolveOpenInput = targetAttempt("resolve-open", "Resolve the prepared open case at its current version", targetVersion, resolveAction, {}, invalidTransitionOutcome)
const zeroVersionInput = targetAttempt("zero-version-triage", "Triage the prepared open case with expected version 0", zeroVersion, triageAction, {}, rejected)
const assignFirstInput = targetAttempt("assign-first", "Assign the prepared triaged case at its current version to the on-duty agent", targetVersion, assignAction, { assignedAgentId: onDutyAgent }, contendedOutcome)
const assignSecondInput = targetAttempt("assign-second", "Assign the prepared triaged case at the same current version to the second on-duty agent", targetVersion, assignAction, { assignedAgentId: secondOnDutyAgent }, contendedOutcome)

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
const lifecycleRequirements = ["SC-OPEN", "SC-LIFECYCLE", "SC-HISTORY", "SC-CHRONOLOGY", "SC-JOIN", "SC-AUDIT", "SC-PRESERVE"]
const deskRequirements = ["SC-LIFECYCLE", "SC-HISTORY", "SC-CHRONOLOGY", "SC-JOIN", "SC-AUDIT", "SC-PRESERVE"]
const raceRequirements = ["SC-RACE", "SC-CHRONOLOGY", "SC-PRESERVE"]
const refusalAssessments = ["SC-REFUSAL-FEEDBACK"]
const unassessed: ReadonlyArray<string> = []
const denialRequirements = ["SC-DENY", "SC-PRESERVE"]
const rejectionRequirements = ["SC-REJECT", "SC-PRESERVE"]
const auditReadRequirements = ["SC-AUDIT-READ", "SC-PRESERVE"]
const auditDenyRequirements = ["SC-AUDIT-DENY", "SC-PRESERVE"]
const auditGoal = "Open the audit trail operation and request the lifecycle audit for the prepared case with the offered input, then reload the page. Do not change any case."

const attemptScenarioAt = (at: string, assessments: ReadonlyArray<string>) => (id: string, fixture: string, goal: string, input: InputDeclaration, requirements: ReadonlyArray<string>): ScenarioDeclaration => ({
  id,
  revision: at,
  provenance,
  approval,
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
  assessments,
  reload: true,
})

const attemptScenario = attemptScenarioAt(attemptRevision, unassessed)
const assessedAttemptScenario = attemptScenarioAt(assessedRevision, refusalAssessments)

const auditScenario = (id: string, story: string, actor: string, input: InputDeclaration, requirements: ReadonlyArray<string>): ScenarioDeclaration => ({
  id,
  revision,
  provenance,
  approval,
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
  assessments: [],
  reload: true,
})

const lifecycleScenario: ScenarioDeclaration = {
  id: "case-lifecycle",
  revision: chronologyRevision,
  provenance,
  approval,
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
  assessments: [],
  reload: true,
}

const deskTriageInput = lifecycleInput("triage", "support.advanceCase", "Triage the prepared open case at its current version with the reproduction note", { caseId: targetId, expectedVersion: targetVersion, action: triageAction, note: triageNote })

const deskScenario: ScenarioDeclaration = {
  id: "desk-triage-assign",
  revision: chronologyRevision,
  provenance,
  approval,
  story: "resolve-customer-problem",
  actor: "operator",
  fixture: "support-target-open",
  goal: "On the support desk, triage the prepared open case with the offered triage note, then assign it to the on-duty agent, using the offered candidate inputs in that order. After the assignment, reload the page.",
  operations: ["support.advanceCase"],
  inputs: [deskTriageInput, assignInput],
  required: ["triage", "assign"],
  observations: lifecycleObservations,
  probes: ["case-detail", "audit-trail"],
  requirements: deskRequirements,
  assessments: [],
  reload: true,
}

const staleScenario = assessedAttemptScenario("stale-version-denied", "support-target-triaged", "Enter and submit the offered stale-version assignment of the prepared triaged case through the Advance case form so that the application's refusal is observed, then reload the page.", staleAssignInput, denialRequirements)
const offDutyScenario = attemptScenario("off-duty-denied", "support-target-triaged", "Enter and submit the offered assignment of the prepared triaged case to the off-duty agent through the Advance case form so that the application's refusal is observed, then reload the page.", offDutyInput, denialRequirements)
const unassignedScenario = attemptScenario("missing-assignment-denied", "support-target-triaged", "Enter and submit the offered assignment of the prepared triaged case without an agent through the Advance case form so that the application's refusal is observed, then reload the page.", unassignedInput, denialRequirements)
const transitionScenario = attemptScenario("disallowed-transition-denied", "support-target-open", "Enter and submit the offered resolution of the prepared open case through the Advance case form so that the application's refusal of that transition is observed, then reload the page.", resolveOpenInput, denialRequirements)
const invalidScenario = attemptScenario("invalid-version-rejected", "support-target-open", "Enter and submit the offered triage of the prepared open case with expected version 0 through the Advance case form so that the application's rejection of input outside the native contract is observed, then reload the page.", zeroVersionInput, rejectionRequirements)
const adminAuditScenario = auditScenario("audit-admin", "review-audit-trail", "administrator", adminAuditInput, auditReadRequirements)
const readerAuditScenario = auditScenario("audit-reader-denied", "audit-withheld-from-reader", "reader", readerAuditInput, auditDenyRequirements)
const visitorAuditScenario = auditScenario("audit-visitor-denied", "audit-withheld-from-visitor", "visitor", visitorAuditInput, auditDenyRequirements)
const raceGoal = (agent: string) => `Open the Advance case form, enter exactly the offered assignment of the prepared triaged case to ${agent} at its current version, and submit it; the harness holds your submission until the other operator is ready to submit theirs, so wait for the application's answer. Then reload the page.`

const raceLanes: ScenarioDeclaration["concurrency"] = {
  barrier: "submit",
  lanes: [
    { id: "first", goal: raceGoal("the on-duty agent"), inputs: [assignFirstInput.id] },
    { id: "second", goal: raceGoal("the second on-duty agent"), inputs: [assignSecondInput.id] },
  ],
}

const raceScenario = (round: number): ScenarioDeclaration => ({
  id: `race-round-${round}`,
  revision: raceRevision,
  provenance: versionPolicy,
  approval,
  story: "settle-competing-assignments",
  actor: "operator",
  fixture: "support-target-triaged",
  goal: "Two operators each assign the same prepared triaged case at the same current version to a different on-duty agent through the Advance case form, submitting together, then reload the page.",
  operations: ["support.advanceCase"],
  inputs: [assignFirstInput, assignSecondInput],
  required: [assignFirstInput.id, assignSecondInput.id],
  observations: lifecycleObservations,
  probes: ["case-detail", "audit-trail"],
  requirements: raceRequirements,
  assessments: [],
  reload: true,
  concurrency: raceLanes,
})

const raceScenarios = Array.map([1, 2, 3], raceScenario)

const requirementFrom = (at: string, source: string) => (id: string, words: string, evaluator: string, category: Requirement["category"]): Declaration["requirements"][number] => ({
  id,
  revision: at,
  provenance: source,
  approval,
  text: words,
  evaluator,
  evaluatorRevision: at,
  category,
  parameters: [],
})

const requirement = requirementFrom(revision, provenance)
const preparedSubjectRequirement = requirementFrom(preparedSubjectRevision, provenance)
const openRequirement = requirement("SC-OPEN", "Opening a case for an existing customer creates exactly one open, unassigned case at version 1 with the submitted subject and priority.", "opened-case", "behavior")
const lifecycleRequirement = preparedSubjectRequirement("SC-LIFECYCLE", "Each accepted lifecycle command follows the native transition graph, advances the version by exactly one, assigns only the submitted on-duty agent, and reopening clears the assignment; the final state survives reload.", "lifecycle-transitions", "behavior")
const historyRequirement = preparedSubjectRequirement("SC-HISTORY", "The case history holds exactly one ordered event per accepted lifecycle command, with the submitted notes and the agent assigned after that command.", "ordered-history", "history")
const joinRequirement = preparedSubjectRequirement("SC-JOIN", "After every accepted command, the case detail joins the current customer and the currently assigned agent, or no agent when unassigned.", "joined-detail", "behavior")
const auditRequirement = preparedSubjectRequirement("SC-AUDIT", "Every accepted lifecycle command appends exactly one succeeded audit record for its case version, readable through the administrator binding.", "audit-recorded", "history")

const preserveRequirement: Declaration["requirements"][number] = {
  ...requirement("SC-PRESERVE", "Unrelated cases, their history and audit records, customers, and agents remain exactly unchanged.", "unrelated-unchanged", "preservation"),
  refines: { requirement: "platform:PLATFORM-PRESERVE", arguments: { scope: "unrelated cases, their history and audit records, customers, and agents" } },
}

const denyRequirement = requirement("SC-DENY", "A native-valid lifecycle attempt that violates version, duty, assignment, or transition policy fails with the declared native failure and leaves the case, its history, and its audit trail unchanged.", "denied-unchanged", "behavior")
const rejectRequirement = requirement("SC-REJECT", "A lifecycle input outside the native contract is rejected before execution and leaves every record unchanged.", "invalid-rejected", "behavior")
const auditReadRequirement = requirement("SC-AUDIT-READ", "An administrator reads exactly the recorded lifecycle audit of the requested case.", "audit-authorized", "authorization")
const auditDenyRequirement = requirement("SC-AUDIT-DENY", "Audit evidence is withheld from readers without the administrator role and from visitors without a session, enforced by the server.", "audit-denied", "authorization")
const raceRequirement = requirementFrom(raceRevision, versionPolicy)("SC-RACE", "When two operators submit native-valid commands for the same case at the same expected version while both requests are in flight, exactly one is accepted and advances the version by one; the other is refused with one of the documented lifecycle refusals (VersionConflict or InvalidSupportCaseTransition) and leaves no assignment, history event, or audit record of its own, so the case equals the winner's result and unrelated records are preserved.", "single-winner", "behavior")
const chronologyRequirement = requirementFrom(revision, historyPolicy)("SC-CHRONOLOGY", "The case history is chronological: its events never go back in occurrence time, the case was opened no later than its first event, and every event appended during the scenario occurs no earlier than every prior event of the case.", "history-chronology", "history")

const refusalFeedbackRequirement: Declaration["requirements"][number] = {
  id: "SC-REFUSAL-FEEDBACK",
  revision,
  provenance: reviewProposal,
  approval,
  text: "Refusal feedback shown to the operator names why the lifecycle command was refused.",
  evaluator: "rubric-assessment",
  evaluatorRevision: "1",
  category: "qualitative",
  parameters: [],
  rubric: "refusal-feedback-clarity",
}

const refusalRubric: Declaration["rubrics"][number] = {
  id: "refusal-feedback-clarity",
  revision,
  provenance: reviewProposal,
  approval,
  criteria: [
    "Names the lifecycle command that was refused",
    "Names the reason for the refusal, such as a version conflict",
    "Tells the operator what to do next, such as reloading the case and retrying at its current version",
  ],
  scale: [
    { level: "unclear", meaning: "The feedback does not say that the command was refused, or gives no understandable reason." },
    { level: "partially-clear", meaning: "The feedback says the command was refused and hints at the reason, but omits the command, the reason, or what to do next." },
    { level: "clear", meaning: "The feedback names the refused command and the reason, and tells the operator what to do next." },
  ],
  threshold: "clear",
  reviewer: "user (approved 2026-10-11)",
}

const actors: Declaration["actors"] = [
  { id: "operator", revision, provenance, approval, binding: "public-operator", description: "A support operator using the public lifecycle commands; the application grants these commands publicly, so no credentials are bound." },
  { id: "administrator", revision, provenance, approval, binding: "admin-session", description: "The seeded administrator account; the harness resolves its session, which is never model-visible." },
  { id: "reader", revision, provenance, approval, binding: "reader-session", description: "The seeded reader account without the administrator role." },
  { id: "visitor", revision, provenance, approval, binding: "anonymous", description: "A visitor with no session." },
]

const reportedProblem: Declaration["contexts"][number] = {
  id: "reported-problem",
  revision: correctedNarrativeRevision,
  provenance,
  approval,
  narrative: "A known customer reports a problem; the reported case may already be open; two agents are on duty and another is off duty; an unrelated case already has history.",
  fixtures: ["support-baseline", "support-target-open"],
}

const competingOperators: Declaration["contexts"][number] = {
  id: "competing-operators",
  revision,
  provenance: versionPolicy,
  approval,
  narrative: "Two operators, each in their own browser session, see the same triaged case at the same version; two agents are on duty and another is off duty; an unrelated case already has history.",
  fixtures: ["support-target-triaged"],
}

const contexts: Declaration["contexts"] = [
  reportedProblem,
  competingOperators,
  { id: "prepared-case-attempt", revision, provenance, approval, narrative: "A prepared case is already open or triaged; the attempt is native-valid except where the scenario declares otherwise.", fixtures: ["support-target-triaged", "support-target-open"] },
  { id: "recorded-audit", revision, provenance, approval, narrative: "A prepared case has opened and triaged audit records.", fixtures: ["support-target-triaged"] },
  { id: "reader-session", revision, provenance, approval, narrative: "The reader holds a valid session without the administrator role.", fixtures: ["support-target-triaged"] },
  { id: "no-session", revision, provenance, approval, narrative: "No session is bound.", fixtures: ["support-target-triaged"] },
]

const needs: Declaration["needs"] = [
  { id: "track-customer-problems", revision, provenance, approval, text: "Track a customer's problem from report to resolution with accountable history." },
  { id: "account-for-changes", revision, provenance, approval, text: "Account for every lifecycle change without exposing that evidence to people who are not administrators." },
]

const capabilities: Declaration["capabilities"] = [
  { id: "open-case", revision, provenance, approval, resource: "support_cases", operations: ["support.openCase"] },
  { id: "advance-case", revision, provenance, approval, resource: "support_cases", operations: ["support.advanceCase"] },
  { id: "audit-lifecycle", revision, provenance, approval, resource: "support_case_audits", operations: ["support.auditTrail"] },
]

const features: Declaration["features"] = [
  { id: "case-management", revision, provenance, approval, title: "Case management", capabilities: ["open-case", "advance-case"] },
  { id: "accountability", revision, provenance, approval, title: "Accountability", capabilities: ["audit-lifecycle"] },
]

const textFixtures: Declaration["textFixtures"] = [{
  id: "case-report",
  revision,
  approval,
  provenance: "examples/support-cases/README.md#triage-and-assign; reopen note authored for this slice",
  values: { subject: "Cannot export quarterly report", triageNote: "Reproduced from the export payload.", resolveNote: "Export permission repaired.", reopenNote: "The customer reports the quarterly export failing again." },
}]

const obligations = [openRequirement, lifecycleRequirement, historyRequirement, chronologyRequirement, joinRequirement, auditRequirement, preserveRequirement, denyRequirement, rejectRequirement, auditReadRequirement, auditDenyRequirement, raceRequirement]
const requirements = [...obligations, refusalFeedbackRequirement]

const resolveStory: Declaration["stories"][number] = { id: "resolve-customer-problem", revision: chronologyRevision, provenance, approval, original: "As a support operator, I want to open a customer's case and move it through triage, assignment to an available agent, resolution, and reopening so that the problem is tracked with accountable history.", actor: "operator", context: "reported-problem", need: "track-customer-problems", capabilities: ["open-case", "advance-case"], requirements: lifecycleRequirements, nonGoals: ["Agent authentication", "Notifications", "Discoverability"], openDecisions: [] }
const raceStory: Declaration["stories"][number] = { id: "settle-competing-assignments", revision: raceRevision, provenance: versionPolicy, approval, original: "As a support operator working alongside another operator, I want only one of two simultaneous assignments of the same case version to take effect and the other refused without changing anything, so that concurrent work never silently overwrites an assignment.", actor: "operator", context: "competing-operators", need: "track-customer-problems", capabilities: ["advance-case"], requirements: raceRequirements, nonGoals: ["Automatic retry", "Merging competing assignments", "Fairness between operators", "Which documented refusal a same-version loser receives: precedence between VersionConflict and InvalidSupportCaseTransition is documented nowhere (note, not an open decision)"], openDecisions: [] }

const stories: Declaration["stories"] = [
  resolveStory,
  { id: "protect-lifecycle-integrity", revision, provenance, approval, original: "As a support operator, I want conflicting or invalid lifecycle attempts refused without changing the case so that concurrent work and duty rules are respected.", actor: "operator", context: "prepared-case-attempt", need: "track-customer-problems", capabilities: ["advance-case"], requirements: ["SC-DENY", "SC-REJECT", "SC-PRESERVE"], nonGoals: ["Concurrent races", "Automatic retry"], openDecisions: [] },
  { id: "review-audit-trail", revision, provenance, approval, original: "As an administrator, I want to read a case's lifecycle audit so that I can account for every change.", actor: "administrator", context: "recorded-audit", need: "account-for-changes", capabilities: ["audit-lifecycle"], requirements: auditReadRequirements, nonGoals: ["Audit export"], openDecisions: [] },
  { id: "audit-withheld-from-reader", revision, provenance, approval, original: "As a reader without administrator rights, I cannot read audit evidence, so that lifecycle accountability stays restricted to administrators.", actor: "reader", context: "reader-session", need: "account-for-changes", capabilities: ["audit-lifecycle"], requirements: auditDenyRequirements, nonGoals: ["Role administration"], openDecisions: [] },
  { id: "audit-withheld-from-visitor", revision, provenance, approval, original: "As a visitor without a session, I cannot read audit evidence.", actor: "visitor", context: "no-session", need: "account-for-changes", capabilities: ["audit-lifecycle"], requirements: auditDenyRequirements, nonGoals: ["Sign-up"], openDecisions: [] },
  raceStory,
]

const scenarios = [lifecycleScenario, deskScenario, staleScenario, offDutyScenario, unassignedScenario, transitionScenario, invalidScenario, adminAuditScenario, readerAuditScenario, visitorAuditScenario, ...raceScenarios]
const atRevision = (target: string) => (declaration: Revision) => `${declaration.id}@${target}`
const catalogDeclaration: Revision = { id: catalogId, revision: catalogRevision, provenance, approval }
const reworded: ReadonlyArray<Revision> = [{ id: catalogId, revision: attemptRevision, provenance, approval }, staleScenario, offDutyScenario, unassignedScenario, transitionScenario, invalidScenario]
const declarations: ReadonlyArray<Revision> = [catalogDeclaration, ...actors, ...contexts, ...needs, ...capabilities, ...features, ...textFixtures, ...obligations, ...stories, ...scenarios]
const preparedSubjectRevised: ReadonlyArray<Revision> = [reportedProblem, lifecycleRequirement, historyRequirement, joinRequirement, auditRequirement]
const deskChanged: ReadonlyArray<Revision> = [catalogDeclaration, ...preparedSubjectRevised, deskScenario]
const policyDerived: ReadonlyArray<Revision> = [raceRequirement, chronologyRequirement, competingOperators, raceStory, ...raceScenarios, resolveStory, lifecycleScenario, deskScenario]
const recordedChanges: ReadonlyArray<Revision> = [reportedProblem, staleScenario]
const raceRevisedObligations: ReadonlyArray<Revision> = [raceRequirement, raceStory, ...raceScenarios]
const raceRevised: ReadonlyArray<Revision> = [catalogDeclaration, ...raceRevisedObligations]
const raceRevisedIds = Array.map(raceRevised, qualified)
const introduced: ReadonlyArray<Revision> = [raceRequirement, chronologyRequirement, competingOperators, raceStory, ...raceScenarios]
const introducedIds = Array.map(introduced, qualified)

// Earlier approval records keep naming the revisions they approved because a later revision bump must never read as an earlier approval of it.
const earlierRevisions = HashMap.make([catalogId, deskCatalogRevision], ["reported-problem", preparedSubjectRevision], ["resolve-customer-problem", revision], ["case-lifecycle", revision], ["desk-triage-assign", revision], ["stale-version-denied", attemptRevision])

const earlierName = (declaration: Revision) => {
  const current = qualified(declaration)
  const earlier = HashMap.get(earlierRevisions, declaration.id)
  const named = Option.map(earlier, (at) => `${declaration.id}@${at}`)

  return Option.getOrElse(named, Function.constant(current))
}

const isIntroduced = (declaration: Revision) => {
  const name = qualified(declaration)

  return Array.contains(introducedIds, name)
}

const earlierDeclarations = Array.filter(declarations, Predicate.not(isIntroduced))
const originalApprovals = Array.map(reworded, atRevision(revision))
const rewordedApprovals = Array.map(reworded, atRevision(attemptRevision))
const deskApprovals = Array.map(deskChanged, earlierName)
const earlierApprovals = Array.map(earlierDeclarations, earlierName)
const structuredCatalog = atRevision(structuredCatalogRevision)(catalogDeclaration)
const structuredRevisions = Array.map(preparedSubjectRevised, atRevision(revision))
const structuredUnchanged = Array.difference(earlierApprovals, deskApprovals)
const structuredApprovals = [structuredCatalog, ...structuredRevisions, ...structuredUnchanged]

// Race declarations revised later are named at revision 1 here because the AP-15 policy record approved only those first revisions, never the evidence-driven revision.
const firstRaceName = (declaration: Revision) => {
  const name = qualified(declaration)
  const revised = Array.contains(raceRevisedIds, name)

  return revised ? atRevision(revision)(declaration) : name
}

const policyApprovals = Array.map(policyDerived, firstRaceName)
const recordedApprovals = [atRevision(recordedCatalogRevision)(catalogDeclaration), ...Array.map(recordedChanges, qualified)]
const raceRevisionApprovals = [atRevision(revisedRaceCatalogRevision)(catalogDeclaration), ...Array.map(raceRevisedObligations, qualified)]
const userApprovals = Array.map([...declarations, refusalFeedbackRequirement, refusalRubric], qualified)

const approvals: Declaration["approvals"] = [
  {
    id: "support-cases-slice-b-approval",
    by: "implementation agent under the user-approved 2026-10-08 integration",
    on: "2026-10-10",
    basis: "Approved story-driven acceptance integration of 2026-10-08 and the AP-05 probe and declaration decisions in the 2026-10-10 Support Cases Slice B record of docs/wiki/validation-strategy.md.",
    approves: originalApprovals,
  },
  {
    id: "support-cases-refusal-wording-approval",
    by: "implementation agent (wording-only change; no obligation changed)",
    on: "2026-10-10",
    basis: "Only the refusal goals' wording changed (state the observable purpose of submitting the offered input), recorded 2026-10-10 in the Slice B record of docs/wiki/validation-strategy.md (ap-06-exploration-1 diagnosis); threshold, actions, evaluators, and obligations are unchanged.",
    approves: rewordedApprovals,
  },
  {
    id: "support-cases-current-approval",
    by: "implementation agent (structure-only change; no obligation changed)",
    on: "2026-10-10",
    basis: "Approved integration of 2026-10-08 plus the recorded Slice B and AP-10 evidence; AP-12 moved story contexts into context declarations, added the Case management and Accountability feature groupings and this history, and declared SC-PRESERVE as a refinement of platform:PLATFORM-PRESERVE without changing any obligation's text, evaluator, or meaning.",
    approves: structuredApprovals,
  },
  {
    id: "support-cases-desk-approval",
    by: "implementation agent (implementation-recorded; not a user approval)",
    on: "2026-10-10",
    basis: "AP-14 added the desk-triage-assign scenario under the approved resolve-customer-problem story and its approved requirements, admitted the prepared open-case fixture support-target-open in the reported-problem context, and bumped the lifecycle-transitions, ordered-history, joined-detail, and audit-recorded evaluators to accept a fixture-prepared subject case without changing any requirement text.",
    approves: deskApprovals,
  },
  {
    id: "support-cases-race-chronology-approval",
    by: "implementation agent deriving from documented policy (not a user approval)",
    on: "2026-10-10",
    basis: "AP-15 derived SC-RACE from examples/support-cases/README.md 'Resolve and inspect history' (\"A stale `expectedVersion` fails with `VersionConflict` and appends no event\") and the optimistic case version of 'Open and query a case' (\"The case starts at status `open`, version `1`\"), and SC-CHRONOLOGY from 'Resolve and inspect history' (the case detail's \"ordered event array\"), 'Open and query a case' (\"`support.openCase` writes the case and its initial `opened` event in one transaction\"), and 'Use the Application UI or MCP' (\"transitions still use `support.openCase` and `support.advanceCase` so event history shares the transaction\"). SC-CHRONOLOGY asserts only the relative order of server-stamped times, so no controlled clock is required. It added the settle-competing-assignments story, the competing-operators context, and the race-round-1..3 scenarios, and added SC-CHRONOLOGY to resolve-customer-problem, case-lifecycle, and desk-triage-assign without changing any other obligation.",
    approves: policyApprovals,
  },
  {
    id: "support-cases-ap15-recorded-approval",
    by: "implementation agent (implementation-recorded; not a user approval)",
    on: "2026-10-10",
    basis: "AP-15 added a second on-duty agent to the isolated fixture, so the reported-problem narrative now states two agents on duty; stale-version-denied gained only a non-gating reference to the proposed SC-REFUSAL-FEEDBACK assessment, with its goal, input, obligations (SC-DENY, SC-PRESERVE), and evaluators unchanged; the catalog revision records these additions. The refusal-feedback-clarity rubric and SC-REFUSAL-FEEDBACK stay proposed and are not approved by this record.",
    approves: recordedApprovals,
  },
  {
    id: "support-cases-race-refusal-revision",
    by: "implementation agent deriving from documented policy and recorded evidence (not a user approval)",
    on: "2026-10-10",
    basis: "AP-15 revised SC-RACE, its story settle-competing-assignments, and race-round-1..3 after ap-15-support-exploration-2 and its replay showed, in all three rounds, the same-version loser refused with InvalidSupportCaseTransition rather than VersionConflict: transition guards run before the version-guarded update (packages/effect-domains/src/resource/compiler.ts) and SQLite serializes transactions, so the loser meets the winner's committed state. Both refusals are documented in examples/support-cases/README.md (\"A stale `expectedVersion` fails with `VersionConflict` and appends no event\"; \"An invalid edge fails with `InvalidSupportCaseTransition`\"), so the loser may be refused with either and must change nothing; the single winner, its one history event and one audit record at version+1, the losing agent's absence, and preservation are unchanged, and the single-winner evaluator moved to revision 2. Note (not an open decision): neither the README nor the domain documents which refusal takes precedence; each round's evidence records the refusal observed.",
    approves: raceRevisionApprovals,
  },
  {
    id: "support-cases-user-approval",
    by: "user",
    on: "2026-10-11",
    basis: "The user approved, in the 2026-10-11 review of the AP-17 open items, every implementation-recorded declaration as recorded (including SC-RACE@2, SC-CHRONOLOGY, the lifecycle requirement revisions, and the desk and race scenarios) and the refusal-feedback-clarity rubric and SC-REFUSAL-FEEDBACK as written; the user also chose to document, rather than change, that transition refusals take precedence over version conflicts. This record approves every current declaration of catalog revision 7.",
    approves: userApprovals,
  },
]

export const supportCasesCatalog: Declaration = {
  id: catalogId,
  revision: catalogRevision,
  provenance,
  approval,
  imports: [{ alias: "platform", catalog: "effect-domains-platform-obligations", revision }],
  approvals,
  actors,
  contexts,
  needs,
  capabilities,
  features,
  textFixtures,
  rubrics: [refusalRubric],
  requirements,
  stories,
  scenarios,
}

