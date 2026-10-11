import type { Catalog } from "@effect-domains/acceptance/model"

const catalogId = "expense-ledger-generation"
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
const merchant = literal("Harbour Stationers")
const periodStart = fixtureFact("period.from")
const periodEnd = fixtureFact("period.through")
const accepted: InputDeclaration["outcome"] = { kind: "accepted" }
const rejected: InputDeclaration["outcome"] = { kind: "rejected" }
const reversedRange: InputDeclaration["outcome"] = { kind: "denied", failure: "InvalidExpenseDateRange" }
const recordRequirements = ["EL-OUTCOME", "EL-RECORDED"]
const refusalRequirements = ["EL-OUTCOME", "EL-UNCHANGED"]

const sampledInput: InputDeclaration = {
  id: "record-sampled",
  operation: "expenses.record",
  description: "Record an expense dated on the first day of the prepared period at a fixed merchant, with category, amount, and currency drawn together from one native whole-payload sample",
  fields: { date: periodStart, merchant, category: nativeSample, amountMinor: nativeSample, currency: nativeSample },
  validity: "native-valid",
  outcome: accepted,
}

const lowercaseInput: InputDeclaration = {
  id: "record-lowercase-currency",
  operation: "expenses.record",
  description: "Record an expense dated on the last day of the prepared period at a fixed merchant with the lowercase currency code usd, which the native three-uppercase-letter currency pattern rejects",
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
  reload: true,
})

const sampledScenario = scenario("record-sampled-expense", "keep-recorded-expense", "Open the Record expense form, enter exactly the offered expense values, and submit them so that the recorded expense is returned, then reload the page.", sampledInput, recordRequirements)
const lowercaseScenario = scenario("lowercase-currency-rejected", "refuse-malformed-expense", "Open the Record expense form, enter exactly the offered expense with the lowercase currency, and submit it so that the application's rejection of input outside the native contract is observed, then reload the page.", lowercaseInput, refusalRequirements)
const reversedScenario = scenario("reversed-totals-denied", "refuse-reversed-totals", "Open the Totals form, enter exactly the offered reversed date range, and submit it so that the application's refusal of a range ending before it starts is observed, then reload the page.", reversedInput, refusalRequirements)

const requirements: Declaration["requirements"] = [
  { id: "EL-OUTCOME", text: "Each submitted expense input is exactly the offered candidate and the ledger answers with the declared outcome: acceptance, rejection by the native contract, or the declared refusal.", evaluator: "declared-outcome" },
  { id: "EL-RECORDED", text: "The recorded expense returned by the ledger contains every submitted value exactly.", evaluator: "recorded-echo" },
  { id: "EL-UNCHANGED", text: "A rejected or refused expense input leaves every recorded expense exactly unchanged after reload.", evaluator: "observation-unchanged" },
]

const actors: Declaration["actors"] = [
  { id: actor, binding: "public-bookkeeper", description: "A bookkeeper using the public ledger; the application grants every operation publicly, so no credentials are bound." },
]

const stories: Declaration["stories"] = [
  { id: "keep-recorded-expense", text: "As a bookkeeper, I want to record an expense with its category, amount, and currency so that the ledger keeps exactly what I entered.", actor, requirements: recordRequirements },
  { id: "refuse-malformed-expense", text: "As a bookkeeper, I want an expense with a malformed currency code refused without changing the ledger.", actor, requirements: refusalRequirements },
  { id: "refuse-reversed-totals", text: "As a bookkeeper, I want totals for a range that ends before it starts refused, so that a reversed range is never read as an empty period.", actor, requirements: refusalRequirements },
]

export const expenseLedgerCatalog: Declaration = {
  id: catalogId,
  actors,
  requirements,
  stories,
  scenarios: [sampledScenario, lowercaseScenario, reversedScenario],
}

/** Every observed resource is read through its native list operation. */
export const listOperation = (resource: string) => `${resource}.list`
