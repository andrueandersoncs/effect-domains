import { Array } from "effect"
import { type Catalog, type Requirement, type Revision, qualified } from "@effect-domains/acceptance/model"

const provenance = "docs/wiki/story-driven-acceptance.md#ap-13-generation-and-captured-codec-coverage"
const revision = "1"
const catalogId = "expense-ledger-generation"
const approval = "approved"
const actor = "bookkeeper"
const fixture = "expense-period"
const observations = ["expenses"]

type Declaration = typeof Catalog.Encoded
type ScenarioDeclaration = Declaration["scenarios"][number]
type InputDeclaration = ScenarioDeclaration["inputs"][number]
type FieldDeclaration = InputDeclaration["fields"][string]

const fixtureFact = (fact: string): FieldDeclaration => ({ source: "fixture", fact, offset: 0 })
const literal = (value: unknown): FieldDeclaration => ({ source: "literal", value })
const nativeSample: FieldDeclaration = { source: "native", strategy: "sample" }
const merchant: FieldDeclaration = { source: "text", fixture: "expense-entry", field: "merchant" }
const periodStart = fixtureFact("period.from")
const periodEnd = fixtureFact("period.through")
const accepted: InputDeclaration["outcome"] = { kind: "accepted" }
const rejected: InputDeclaration["outcome"] = { kind: "rejected" }
const reversedRange: InputDeclaration["outcome"] = { kind: "denied", failure: "InvalidExpenseDateRange" }
const recordRequirements = ["EL-OUTCOME", "EL-LOSSLESS", "EL-GENERATED"]
const refusalRequirements = ["EL-OUTCOME", "EL-UNCHANGED"]

const sampledInput: InputDeclaration = {
  id: "record-sampled",
  operation: "expenses.record",
  description: "Record an expense dated on the first day of the prepared period at the approved merchant, with category, amount, and currency drawn together from one native whole-payload sample",
  fields: { date: periodStart, merchant, category: nativeSample, amountMinor: nativeSample, currency: nativeSample },
  validity: "native-valid",
  outcome: accepted,
}

const lowercaseInput: InputDeclaration = {
  id: "record-lowercase-currency",
  operation: "expenses.record",
  description: "Record an expense dated on the last day of the prepared period at the approved merchant with the lowercase currency code usd, which the native three-uppercase-letter currency pattern rejects",
  fields: { date: periodEnd, merchant, category: nativeSample, amountMinor: nativeSample, currency: literal("usd") },
  validity: "native-invalid",
  outcome: rejected,
}

const reversedInput: InputDeclaration = {
  id: "totals-reversed",
  operation: "expenses.totals",
  description: "Ask for totals from the last day of the prepared period through its first day, a well-formed range the ledger refuses because it ends before it starts",
  fields: { from: periodEnd, through: periodStart },
  validity: "native-valid",
  outcome: reversedRange,
}

const scenario = (id: string, story: string, goal: string, input: InputDeclaration, requirements: ReadonlyArray<string>): ScenarioDeclaration => ({
  id,
  revision,
  provenance,
  approval,
  story,
  actor,
  fixture,
  goal,
  operations: [input.operation],
  inputs: [input],
  required: [input.id],
  observations,
  probes: [],
  requirements,
  assessments: [],
  reload: true,
})

const sampledScenario = scenario("record-sampled-expense", "keep-recorded-expense", "Open the Record expense form, enter exactly the offered expense values, and submit them so that the recorded expense is returned, then reload the page.", sampledInput, recordRequirements)
const lowercaseScenario = scenario("lowercase-currency-rejected", "refuse-malformed-expense", "Open the Record expense form, enter exactly the offered expense with the lowercase currency, and submit it so that the application's rejection of input outside the native contract is observed, then reload the page.", lowercaseInput, refusalRequirements)
const reversedScenario = scenario("reversed-totals-denied", "refuse-reversed-totals", "Open the Totals form, enter exactly the offered reversed date range, and submit it so that the application's refusal of a range ending before it starts is observed, then reload the page.", reversedInput, refusalRequirements)

const requirement = (id: string, words: string, evaluator: string, category: Requirement["category"]): Declaration["requirements"][number] => ({
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

const outcomeRequirement = requirement("EL-OUTCOME", "Each submitted expense input is exactly the approved candidate, the exact native codec judges it as declared, and the ledger answers with the declared outcome: acceptance, rejection by the native contract, or the declared native refusal.", "declared-outcome", "behavior")
const losslessRequirement = requirement("EL-LOSSLESS", "An accepted expense decodes and re-encodes through the native codec without loss, and the recorded expense returned by the ledger contains every submitted value exactly.", "lossless-roundtrip", "behavior")
const generatedRequirement = requirement("EL-GENERATED", "The submitted expense names only caller fields; the server-generated expense id never appears in the input.", "generated-excluded", "behavior")

const unchangedRequirement: Declaration["requirements"][number] = {
  ...requirement("EL-UNCHANGED", "A rejected or refused expense input leaves every recorded expense exactly unchanged after reload.", "observation-unchanged", "preservation"),
  refines: { requirement: "platform:PLATFORM-PRESERVE", arguments: { scope: "every recorded expense of the prepared period" } },
}

const actors: Declaration["actors"] = [
  { id: actor, revision, provenance, approval, binding: "public-bookkeeper", description: "A bookkeeper using the public ledger; the application grants every operation publicly, so no credentials are bound." },
]

const contexts: Declaration["contexts"] = [
  { id: "recorded-period", revision, provenance, approval, narrative: "A two-day expense period already holds two recorded expenses in different currencies.", fixtures: [fixture] },
]

const needs: Declaration["needs"] = [
  { id: "account-for-spending", revision, provenance, approval, text: "Keep an exact record of business spending and its totals per category and currency." },
]

const capabilities: Declaration["capabilities"] = [
  { id: "record-expense", revision, provenance, approval, resource: "expenses", operations: ["expenses.record"] },
  { id: "total-expenses", revision, provenance, approval, resource: "expenses", operations: ["expenses.totals"] },
]

const features: Declaration["features"] = [
  { id: "expense-ledger", revision, provenance, approval, title: "Expense ledger", capabilities: ["record-expense", "total-expenses"] },
]

const textFixtures: Declaration["textFixtures"] = [{
  id: "expense-entry",
  revision,
  approval,
  provenance: "examples/expense-ledger/README.md#run-it; merchant authored for AP-13",
  values: { merchant: "Harbour Stationers" },
}]

const requirements = [outcomeRequirement, losslessRequirement, generatedRequirement, unchangedRequirement]

const stories: Declaration["stories"] = [
  { id: "keep-recorded-expense", revision, provenance, approval, original: "As a bookkeeper, I want to record an expense with its category, amount, and currency so that the ledger keeps exactly what I entered.", actor, context: "recorded-period", need: "account-for-spending", capabilities: ["record-expense"], requirements: recordRequirements, nonGoals: ["Currency conversion", "Editing", "Authentication"], openDecisions: [] },
  { id: "refuse-malformed-expense", revision, provenance, approval, original: "As a bookkeeper, I want an expense with a malformed currency code refused without changing the ledger.", actor, context: "recorded-period", need: "account-for-spending", capabilities: ["record-expense"], requirements: refusalRequirements, nonGoals: ["Currency normalization"], openDecisions: [] },
  { id: "refuse-reversed-totals", revision, provenance, approval, original: "As a bookkeeper, I want totals for a range that ends before it starts refused, so that a reversed range is never read as an empty period.", actor, context: "recorded-period", need: "account-for-spending", capabilities: ["total-expenses"], requirements: refusalRequirements, nonGoals: ["Range auto-correction"], openDecisions: [] },
]

const scenarios = [sampledScenario, lowercaseScenario, reversedScenario]
const declarations: ReadonlyArray<Revision> = [{ id: catalogId, revision, provenance, approval }, ...actors, ...contexts, ...needs, ...capabilities, ...features, ...textFixtures, ...requirements, ...stories, ...scenarios]
const currentApprovals = Array.map(declarations, qualified)

const approvals: Declaration["approvals"] = [{
  id: "expense-ledger-generation-approval",
  by: "implementation agent under the user-approved AP-13 generation-matrix package",
  on: "2026-10-10",
  basis: "AP-13 of docs/wiki/story-driven-acceptance.md and the read-only probe of examples/expense-ledger: expenses.record decodes the published Expense schema with a three-uppercase-letter currency pattern, a lowercase currency is rejected by the codec with HTTP 400, and expenses.totals raises InvalidExpenseDateRange in its handler for a reversed range (HTTP 422).",
  approves: currentApprovals,
}]

export const expenseLedgerCatalog: Declaration = {
  id: catalogId,
  revision,
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
  rubrics: [],
  stories,
  scenarios,
}
