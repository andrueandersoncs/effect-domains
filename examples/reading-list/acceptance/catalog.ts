import { Array } from "effect"
import { type Catalog, type NativeStrategySchema, type Requirement, type Revision, qualified } from "@effect-domains/acceptance/model"

const provenance = "docs/wiki/story-driven-acceptance.md#slice-a-reading-list"
const revision = "1"
const representationRevision = "2"
const priorCatalogRevision = "3"
const catalogRevision = "4"
const assessedRevision = "3"
const assessedScenario = "rating-above"
const clarityRubric = "rating-rejection-clarity"
const clarityRequirement = "RL-REJECT-CLARITY"
const catalogId = "reading-list-slice-a"
const approval = "approved"
const resource = "books"
const actor = "reader"
const createFixture = "isolated-reading-list"
const targetFixture = "isolated-reading-list-target"
const observations = ["books"]
const createRequirements = ["RL-CREATE", "RL-RELOAD", "RL-PRESERVE"]
const acceptedRatingRequirements = ["RL-RATING", "RL-RELOAD", "RL-PRESERVE"]
const rejectedRatingRequirements = ["RL-REJECT", "RL-PRESERVE"]
const createGoal = "Record the proposed book through the generated form, then reload and verify it in the unfiltered Books list. Leave the unrelated book unchanged."
const acceptedRatingGoal = "Apply the proposed valid rating to the identified planned book through the update form, then reload and inspect the unfiltered Books list. Leave the unrelated book unchanged."
const rejectedRatingGoal = "Attempt the proposed invalid rating for the identified target through the update form. The server must reject it. Reload and inspect the unfiltered Books list without changing either book."

type Declaration = typeof Catalog.Encoded
type ScenarioDeclaration = Declaration["scenarios"][number]
type InputDeclaration = ScenarioDeclaration["inputs"][number]
type FieldDeclaration = InputDeclaration["fields"][string]
type Fields = InputDeclaration["fields"]
type Strategy = typeof NativeStrategySchema.Type
type RequirementDeclaration = Declaration["requirements"][number]

const text = (field: string): FieldDeclaration => ({ source: "text", fixture: "documented-book-text", field })
const native = (strategy: Strategy): FieldDeclaration => ({ source: "native", strategy })
const targetFact = (field: string): FieldDeclaration => ({ source: "fixture", fact: `target.${field}`, offset: 0 })
const accepted: InputDeclaration["outcome"] = { kind: "accepted" }
const rejected: InputDeclaration["outcome"] = { kind: "rejected" }
const sample = native("sample")

const createInput = (strategy: "sample" | "null" | "omitted", description: string, rating: Fields): InputDeclaration => ({
  id: strategy,
  operation: "books.create",
  description,
  fields: { title: text("title"), author: text("author"), status: sample, format: sample, notes: sample, ...rating },
  validity: "native-valid",
  outcome: accepted,
})

const createScenario = (input: InputDeclaration): ScenarioDeclaration => ({
  id: `create-${input.id}`,
  revision: representationRevision,
  provenance,
  approval,
  story: "record-reading",
  actor,
  fixture: createFixture,
  goal: createGoal,
  operations: ["books.create"],
  inputs: [input],
  required: [input.id],
  observations,
  probes: [],
  requirements: createRequirements,
  assessments: [],
  reload: true,
})

const ratingInput = (strategy: Exclude<Strategy, "sample">, valid: boolean, description: string): InputDeclaration => ({
  id: strategy,
  operation: "books.update",
  description,
  fields: {
    id: targetFact("id"),
    title: targetFact("title"),
    author: targetFact("author"),
    status: targetFact("status"),
    format: targetFact("format"),
    notes: targetFact("notes"),
    rating: native(strategy),
  },
  validity: valid ? "native-valid" : "native-invalid",
  outcome: valid ? accepted : rejected,
})

const ratingScenario = (input: InputDeclaration, valid: boolean): ScenarioDeclaration => ({
  id: `rating-${input.id}`,
  revision: representationRevision,
  provenance,
  approval,
  story: "rate-reading",
  actor,
  fixture: targetFixture,
  goal: valid ? acceptedRatingGoal : rejectedRatingGoal,
  operations: ["books.update"],
  inputs: [input],
  required: [input.id],
  observations,
  probes: [],
  requirements: valid ? acceptedRatingRequirements : rejectedRatingRequirements,
  assessments: [],
  reload: true,
})

const requirement = (id: string, words: string, evaluator: string, category: Requirement["category"]): RequirementDeclaration => ({
  id,
  revision,
  provenance,
  approval,
  text: words,
  evaluator,
  evaluatorRevision: revision,
  category,
  parameters: [],
})

const sampledRating: Fields = { rating: sample }
const nullRating: Fields = { rating: native("null") }
const omittedRating: Fields = {}
const createSample = createInput("sample", "Record the documented book with native sample status, format, notes, and rating", sampledRating)
const createNull = createInput("null", "Record the documented book with native sample status, format, and notes and an explicit null rating", nullRating)
const createOmitted = createInput("omitted", "Record the documented book with native sample status, format, and notes and no rating field", omittedRating)
const ratingMinimum = ratingInput("minimum", true, "Update the prepared planned book, keeping its other values, with the native minimum rating")
const ratingMaximum = ratingInput("maximum", true, "Update the prepared planned book, keeping its other values, with the native maximum rating")
const ratingNull = ratingInput("null", true, "Update the prepared planned book, keeping its other values, with a null rating")
const ratingBelow = ratingInput("below", false, "Update the prepared planned book, keeping its other values, with a rating one below the native minimum")
const ratingAbove = ratingInput("above", false, "Update the prepared planned book, keeping its other values, with a rating one above the native maximum")
const ratingFractional = ratingInput("fractional", false, "Update the prepared planned book, keeping its other values, with a fractional rating within the native bounds")

const unassessedScenarios = [
  createScenario(createSample),
  createScenario(createNull),
  createScenario(createOmitted),
  ratingScenario(ratingMinimum, true),
  ratingScenario(ratingMaximum, true),
  ratingScenario(ratingNull, true),
  ratingScenario(ratingBelow, false),
]

const ratingFractionalScenario = ratingScenario(ratingFractional, false)
const ratingAboveScenario: ScenarioDeclaration = { ...ratingScenario(ratingAbove, false), revision: assessedRevision, assessments: [clarityRequirement] }
const scenarios = [...unassessedScenarios, ratingAboveScenario, ratingFractionalScenario]

const preserveRequirement: RequirementDeclaration = {
  ...requirement("RL-PRESERVE", "The known unrelated fixture retains its identity and all values during every attempt.", "sentinel-unchanged", "preservation"),
  refines: { requirement: "platform:PLATFORM-PRESERVE", arguments: { scope: "the unrelated sentinel book" } },
}

const actors: Declaration["actors"] = [{ id: actor, revision, provenance, approval, binding: "public-reader", description: "An ordinary reader using this public local application; no authentication or inferred permissions." }]

const contexts: Declaration["contexts"] = [
  { id: "public-reading-list", revision, provenance, approval, narrative: "This application is public; the reader has a book to remember.", fixtures: [createFixture] },
  { id: "recorded-and-unrelated-books", revision, provenance, approval, narrative: "A recorded book and an unrelated book already exist; planned status is permitted.", fixtures: [targetFixture] },
]

const needs: Declaration["needs"] = [{ id: "remember-books", revision, provenance, approval, text: "Retain books and ratings in a reading list." }]

const capabilities: Declaration["capabilities"] = [
  { id: "record-book", revision, provenance, approval, resource, operations: ["books.create"] },
  { id: "rate-book", revision, provenance, approval, resource, operations: ["books.update"] },
]

const features: Declaration["features"] = [{ id: "reading-list", revision, provenance, approval, title: "Reading list", capabilities: ["record-book", "rate-book"] }]
const textFixtures: Declaration["textFixtures"] = [{ id: "documented-book-text", revision, approval, provenance: "examples/reading-list/README.md#add-books-and-record-progress", values: { title: "The Dispossessed", author: "Ursula K. Le Guin" } }]

const clarity: RequirementDeclaration = {
  id: clarityRequirement,
  revision,
  provenance: "docs/wiki/story-driven-acceptance.md#ap-15",
  approval: "proposed",
  text: "The rejection feedback for an out-of-range rating is understandable to the reader.",
  evaluator: "rubric-assessment",
  evaluatorRevision: revision,
  category: "qualitative",
  parameters: [],
  rubric: clarityRubric,
}

const approvedRequirements = [
  requirement("RL-CREATE", "Creating a book records exactly the submitted values under a new server-owned identity.", "created-values", "behavior"),
  requirement("RL-RELOAD", "The intended book identity and values remain visible in the loaded, unfiltered list after reload.", "reload-visible", "behavior"),
  requirement("RL-RATING", "The native contract's valid rating cases are accepted for the intended book without requiring finished status.", "accepted-rating", "behavior"),
  requirement("RL-REJECT", "A rating outside the native successful contract is rejected and leaves every book unchanged.", "rejection-unchanged", "behavior"),
  preserveRequirement,
]

const requirements = [...approvedRequirements, clarity]

const rubrics: Declaration["rubrics"] = [{
  id: clarityRubric,
  revision,
  provenance: "docs/wiki/story-driven-acceptance.md#ap-15",
  approval: "proposed",
  criteria: [
    "Says the rating was not accepted.",
    "Says the allowed rating range or why the rating was refused.",
    "Does not claim that the rating was saved or the update succeeded.",
  ],
  scale: [
    { level: "confusing", meaning: "The reader cannot tell that the rating was refused, or the feedback suggests success." },
    { level: "understandable-with-effort", meaning: "The refusal is evident, but the allowed range or reason must be inferred from technical detail." },
    { level: "understandable", meaning: "The feedback plainly says the rating was not accepted and why or what range is allowed, without claiming success." },
  ],
  threshold: "understandable",
  reviewer: "product owner (not yet assigned)",
}]

const stories: Declaration["stories"] = [
  { id: "record-reading", revision, provenance, approval, original: "As a reader, I want to record a book in my reading list so that I can see it again after reloading.", actor, context: "public-reading-list", need: "remember-books", capabilities: ["record-book"], requirements: createRequirements, nonGoals: ["Authentication", "Restart durability", "Discoverability"], openDecisions: [] },
  { id: "rate-reading", revision, provenance, approval, original: "As a reader, I want to rate a recorded book within the native rating contract, with rejected attempts preserving all books.", actor, context: "recorded-and-unrelated-books", need: "remember-books", capabilities: ["rate-book"], requirements: ["RL-RATING", "RL-REJECT", "RL-RELOAD", "RL-PRESERVE"], nonGoals: ["Finished-status policy", "Rating history", "Authorization denial", "Concurrency"], openDecisions: [] },
]

const atRevision = (target: string) => (declaration: Revision) => `${declaration.id}@${target}`
const representationChanged: ReadonlyArray<Revision> = [{ id: catalogId, revision: representationRevision, provenance, approval }, ...scenarios]
const unchanged: ReadonlyArray<Revision> = [...actors, ...contexts, ...needs, ...capabilities, ...features, ...textFixtures, ...approvedRequirements, ...stories, ...unassessedScenarios, ratingFractionalScenario]
const originalApprovals = Array.map(representationChanged, atRevision(revision))
const representationApprovals = Array.map(representationChanged, atRevision(representationRevision))
const structureApprovals = [`${catalogId}@${priorCatalogRevision}`, `${assessedScenario}@${representationRevision}`, ...Array.map(unchanged, qualified)]
const assessmentApprovals = [`${catalogId}@${catalogRevision}`, `${assessedScenario}@${assessedRevision}`]

const approvals: Declaration["approvals"] = [
  {
    id: "reading-list-slice-a-approval",
    by: "implementation agent under the user-approved 2026-10-08 integration",
    on: "2026-10-08",
    basis: "Approved story-driven acceptance integration of 2026-10-08 and the Slice A evidence recorded in docs/wiki/validation-strategy.md#2026-10-08-reading-list-story-driven-acceptance-slice-a.",
    approves: originalApprovals,
  },
  {
    id: "reading-list-representation-approval",
    by: "implementation agent (representation-only change; no obligation changed)",
    on: "2026-10-10",
    basis: "Only the representation changed (per-field input sources, created identity from the create result) during the AP-10 shared extraction recorded 2026-10-10 in docs/wiki/validation-strategy.md#2026-10-10-evidence-backed-shared-extraction-ap-10; obligations, verdict semantics, and verifier controls are unchanged.",
    approves: representationApprovals,
  },
  {
    id: "reading-list-current-approval",
    by: "implementation agent (structure-only change; no obligation changed)",
    on: "2026-10-10",
    basis: "Approved integration of 2026-10-08 plus the recorded Slice A and AP-10 evidence; AP-12 moved story contexts into context declarations, added the Reading list feature grouping and this history, and declared RL-PRESERVE as a refinement of platform:PLATFORM-PRESERVE without changing any obligation's text, evaluator, or meaning.",
    approves: structureApprovals,
  },
  {
    id: "reading-list-assessment-reference-approval",
    by: "implementation agent (non-gating assessment reference added; obligations unchanged; not a user approval)",
    on: "2026-10-10",
    basis: "AP-15 of docs/wiki/story-driven-acceptance.md: rating-above references the proposed qualitative requirement RL-REJECT-CLARITY under assessments only; its inputs, goal, gating requirements, evaluators, and verdict semantics are unchanged, and the catalog revision changed only to declare the proposed rubric and requirement.",
    approves: assessmentApprovals,
  },
]

export const readingListCatalog: Declaration = {
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
  requirements,
  rubrics,
  stories,
  scenarios,
}
