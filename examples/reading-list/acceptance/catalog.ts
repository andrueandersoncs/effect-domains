import type { Catalog, NativeStrategySchema } from "@effect-domains/acceptance/model"

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

/** Every observed resource is read through its native list operation because the generated UI shows each resource as a list. */
export const observationOperation = (resource: string) => `${resource}.list`

type Declaration = typeof Catalog.Encoded
type ScenarioDeclaration = Declaration["scenarios"][number]
type InputDeclaration = ScenarioDeclaration["inputs"][number]
type FieldDeclaration = InputDeclaration["fields"][string]
type Fields = InputDeclaration["fields"]
type Strategy = typeof NativeStrategySchema.Type

const literal = (value: string): FieldDeclaration => ({ source: "literal", value })
const native = (strategy: Strategy): FieldDeclaration => ({ source: "native", strategy })
const targetFact = (field: string): FieldDeclaration => ({ source: "fixture", fact: `target.${field}`, offset: 0 })
const accepted: InputDeclaration["outcome"] = { kind: "accepted" }
const rejected: InputDeclaration["outcome"] = { kind: "rejected" }
const sample = native("sample")

// The documented README book is the literal title and author because the create scenarios exercise the documented example.
const createInput = (strategy: "sample" | "null" | "omitted", description: string, rating: Fields): InputDeclaration => ({
  id: strategy,
  operation: "books.create",
  description,
  fields: { title: literal("The Dispossessed"), author: literal("Ursula K. Le Guin"), status: sample, format: sample, notes: sample, ...rating },
  validity: "native-valid",
  outcome: accepted,
})

const createScenario = (input: InputDeclaration): ScenarioDeclaration => ({
  id: `create-${input.id}`,
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
  reload: true,
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

export const readingListCatalog: Declaration = {
  id: "reading-list",
  actors: [{ id: actor, binding: "public-reader", description: "An ordinary reader using this public local application; no authentication or inferred permissions." }],
  requirements: [
    { id: "RL-CREATE", text: "Creating a book records exactly the submitted values under a new server-owned identity.", evaluator: "created-values" },
    { id: "RL-RELOAD", text: "The intended book identity and values remain visible in the loaded, unfiltered list after reload.", evaluator: "reload-visible" },
    { id: "RL-RATING", text: "The native contract's valid rating cases are accepted for the intended book without requiring finished status.", evaluator: "accepted-rating" },
    { id: "RL-REJECT", text: "A rating outside the native successful contract is rejected and leaves every book unchanged.", evaluator: "rejection-unchanged" },
    { id: "RL-PRESERVE", text: "The known unrelated fixture retains its identity and all values during every attempt.", evaluator: "sentinel-unchanged" },
  ],
  stories: [
    { id: "record-reading", text: "As a reader, I want to record a book in my reading list so that I can see it again after reloading.", actor, requirements: createRequirements },
    { id: "rate-reading", text: "As a reader, I want to rate a recorded book within the native rating contract, with rejected attempts preserving all books.", actor, requirements: ["RL-RATING", "RL-REJECT", "RL-RELOAD", "RL-PRESERVE"] },
  ],
  scenarios: [
    createScenario(createSample),
    createScenario(createNull),
    createScenario(createOmitted),
    ratingScenario(ratingMinimum, true),
    ratingScenario(ratingMaximum, true),
    ratingScenario(ratingNull, true),
    ratingScenario(ratingBelow, false),
    ratingScenario(ratingAbove, false),
    ratingScenario(ratingFractional, false),
  ],
}
