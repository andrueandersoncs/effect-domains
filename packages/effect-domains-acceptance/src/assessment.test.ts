import { expect, it } from "@effect/vitest"
import { Effect, Function, Option } from "effect"
import { AssessedRequirement, approvalLabel, ratedAssessment, unratedAssessment, unresolved } from "./assessment.ts"
import { AssessmentEvidence, Decision, Rubric, RubricLevel, Scenario } from "./model.ts"

const scale = [
  RubricLevel.make({ level: "confusing", meaning: "The person cannot tell why the input was refused." }),
  RubricLevel.make({ level: "understandable", meaning: "The person can tell what was refused and why." }),
]

const proposedRubric = Rubric.make({ id: "clarity", revision: "1", provenance: "assessment test", approval: "proposed", criteria: ["Names the reason for the refusal"], scale, threshold: "understandable", reviewer: "product owner (not yet assigned)" })
const approvedRubric = Rubric.make({ id: "clarity", revision: "1", provenance: "assessment test", approval: "approved", criteria: ["Names the reason for the refusal"], scale, threshold: "understandable", reviewer: "product owner" })
const proposed = AssessedRequirement.make({ reference: "REQ-CLEAR", revision: "1", approval: "proposed", rubric: proposedRubric })
const approved = AssessedRequirement.make({ reference: "REQ-CLEAR", revision: "1", approval: "approved", rubric: approvedRubric })

const scenario = Scenario.make({
  id: "refusal",
  revision: "1",
  provenance: "assessment test",
  approval: "approved",
  story: "story",
  actor: "person",
  fixture: "fixture",
  goal: "Submit the refused input.",
  operations: [],
  inputs: [],
  required: [],
  observations: [],
  probes: [],
  requirements: [],
  assessments: ["REQ-CLEAR"],
  reload: false,
  concurrency: Option.none(),
  watch: Option.none(),
})

const shot = Option.some("step-3.png")
const evidence = [AssessmentEvidence.make({ inputCase: "refused", operation: "ratings.rate", status: 422, feedback: "Rating refused: VersionConflict", screenshot: shot })]
const references = ["scenario.json", "step-3.png"]
const decided = (choice: string) => Decision.make({ choice, confidence: 0.9, probabilities: { confusing: 0.1, understandable: 0.9 }, model: "jev-test", request: {}, response: {} })
const understandable = decided("understandable")
const confusing = decided("confusing")
const rated = Option.some("understandable")
const met = Option.some(true)
const missed = Option.some(false)
const undecided = Option.none<Decision>()

const labelingTest = Effect.gen(function* () {
  const proposedRun = ratedAssessment(proposed, scenario, evidence, references)(understandable)
  const passingRun = ratedAssessment(approved, scenario, evidence, references)(understandable)
  const failingRun = ratedAssessment(approved, scenario, evidence, references)(confusing)
  const blockedRun = unratedAssessment(proposed, scenario, evidence, references)("blocked", "a model-free replay performs no model assessment.")
  const requirementLabel = approvalLabel("approved", "proposed")
  const proposedPass = unresolved("proposed", "proposed", "pass")
  const approvedPass = unresolved("approved", "approved", "pass")
  const approvedInconclusive = unresolved("approved", "approved", "inconclusive")

  expect(proposedRun.result.basis).toBe("model assessment")
  expect(proposedRun.result.status).toBe("inconclusive")
  expect(proposedRun.result.explanation).toContain("model assessment (proposed rubric; not approved)")
  expect(proposedRun.result.explanation).toContain("not counted as a pass or fail")
  expect(proposedRun.level).toEqual(rated)
  expect(proposedRun.meetsThreshold).toEqual(met)
  expect(passingRun.result.status).toBe("pass")
  expect(passingRun.result.explanation).toContain("model assessment (approved rubric)")
  expect(failingRun.result.status).toBe("fail")
  expect(failingRun.meetsThreshold).toEqual(missed)
  expect(blockedRun.result.status).toBe("blocked")
  expect(blockedRun.result.basis).toBe("model assessment")
  expect(blockedRun.decision).toEqual(undecided)
  expect(requirementLabel).toBe("model assessment (proposed requirement; not approved)")
  expect(proposedPass).toBe(true)
  expect(approvedPass).toBe(false)
  expect(approvedInconclusive).toBe(true)
})

it.effect("a model rating is labeled model assessment and stays unresolved until both the requirement and its rubric are approved", Function.constant(labelingTest))
