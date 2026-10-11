import { Array, Equal, Option, Schema, Struct, flow, pipe } from "effect"
import { ApprovalSchema, AssessmentRun, type AssessmentEvidence, type Decision, type Requirement, RequirementResult, type Revision, Rubric, type Scenario } from "./model.ts"

/** The package-owned qualitative evaluator because a rubric assessment is the same model-assessment procedure for every application. */
export const rubricAssessment = "rubric-assessment"

export const rubricAssessmentRevision = "1"

/** A qualitative requirement is only ever rated by a model assessment because its meaning is a product judgment, not an executable assertion. */
export const isQualitative = (requirement: Requirement) => Equal.equals(requirement.category, "qualitative")

type Approval = Revision["approval"]

/**
 * Names the approval state a model assessment ran under because a rating against an unapproved rubric or requirement must read as
 * unresolved wherever it is shown, never as validated benefit.
 */
export const approvalLabel = (rubric: Approval, requirement: Approval) => {
  const unapprovedRubric = !Equal.equals(rubric, "approved")
  const approvedRequirement = Equal.equals(requirement, "approved")

  if (unapprovedRubric) return `model assessment (${rubric} rubric; not approved)`

  return approvedRequirement ? "model assessment (approved rubric)" : `model assessment (${requirement} requirement; not approved)`
}

const bothApproved = (rubric: Approval, requirement: Approval) => {
  const approvedRubric = Equal.equals(rubric, "approved")
  const approvedRequirement = Equal.equals(requirement, "approved")

  return approvedRubric && approvedRequirement
}

/** What one assessment rates: the requirement reference, revision, and approval, and the rubric it is judged against. */
export class AssessedRequirement extends Schema.Class<AssessedRequirement>("AssessedRequirement")({
  reference: Schema.String,
  revision: Schema.String,
  approval: ApprovalSchema,
  rubric: Rubric,
}) {}

const levelIndex = (rubric: Rubric) => (level: string) => Array.findFirstIndex(rubric.scale, flow(Struct.get("level"), Equal.equals(level)))

const atLeast = ([level, minimum]: readonly [number, number]) => level >= minimum

const assessmentResult = (assessed: AssessedRequirement, scenario: Scenario, references: ReadonlyArray<string>) => (status: RequirementResult["status"], explanation: string) => RequirementResult.make({
  requirement: assessed.reference,
  requirementRevision: assessed.revision,
  scenario: scenario.id,
  scenarioRevision: scenario.revision,
  evaluator: rubricAssessment,
  evaluatorRevision: rubricAssessmentRevision,
  basis: "model assessment",
  status,
  explanation,
  evidence: references,
})

/** An assessment that produced no rating (no feedback, a replay, or a failed model call) because it must stay visibly unresolved. */
export const unratedAssessment = (assessed: AssessedRequirement, scenario: Scenario, evidence: ReadonlyArray<AssessmentEvidence>, references: ReadonlyArray<string>) => (status: RequirementResult["status"], reason: string) => {
  const label = approvalLabel(assessed.rubric.approval, assessed.approval)
  const result = assessmentResult(assessed, scenario, references)(status, `${label}: ${reason}`)

  return AssessmentRun.make({ result, requirementApproval: assessed.approval, rubric: assessed.rubric, evidence, decision: Option.none(), level: Option.none(), meetsThreshold: Option.none() })
}

/**
 * Turns a model's rubric rating into a result labeled `model assessment`: pass or fail against the threshold only when both the requirement
 * and its rubric are approved, otherwise inconclusive with the rating retained, because an unapproved product judgment is never a pass.
 */
export const ratedAssessment = (assessed: AssessedRequirement, scenario: Scenario, evidence: ReadonlyArray<AssessmentEvidence>, references: ReadonlyArray<string>) => (decision: Decision) => {
  const { rubric } = assessed
  const rated = levelIndex(rubric)(decision.choice)
  const threshold = levelIndex(rubric)(rubric.threshold)
  const meetsThreshold = pipe(Option.all([rated, threshold]), Option.exists(atLeast))
  const approved = bothApproved(rubric.approval, assessed.approval)
  const verdict = meetsThreshold ? "pass" : "fail"
  const status = approved ? verdict : "inconclusive"
  const label = approvalLabel(rubric.approval, assessed.approval)
  const position = meetsThreshold ? "at or above" : "below"
  const counting = approved ? "counted under the approved rubric as a model assessment, never as an executable assertion" : "not counted as a pass or fail because the requirement and rubric are not approved"
  const explanation = `${label}: ${decision.model} rated the shown feedback "${decision.choice}" with confidence ${decision.confidence} against rubric ${rubric.id}@${rubric.revision} threshold "${rubric.threshold}" (${position} it); ${counting}.`
  const result = assessmentResult(assessed, scenario, references)(status, explanation)
  const level = Option.some(decision.choice)
  const met = Option.some(meetsThreshold)

  return AssessmentRun.make({ result, requirementApproval: assessed.approval, rubric, evidence, decision: Option.some(decision), level, meetsThreshold: met })
}

/** Whether an assessment result is still unresolved because only an approved rubric's pass or fail settles a qualitative obligation. */
export const unresolved = (rubric: Approval, requirement: Approval, status: RequirementResult["status"]) => {
  const approved = bothApproved(rubric, requirement)
  const decided = Array.contains(["pass", "fail"], status)
  const settled = approved && decided

  return !settled
}
