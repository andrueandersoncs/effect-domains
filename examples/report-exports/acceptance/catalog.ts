import type { Catalog } from "@effect-domains/acceptance/model"

const editor = "editor"
const reader = "reader"
const fixture = "acme-exports"
const operation = "ReportExport.GenerateDiscard"
const storedExports = "stored-exports"

type Declaration = typeof Catalog.Encoded
type ScenarioDeclaration = Declaration["scenarios"][number]
type InputDeclaration = ScenarioDeclaration["inputs"][number]
type FieldDeclaration = InputDeclaration["fields"][string]

const literal = (value: unknown): FieldDeclaration => ({ source: "literal", value })
const nativeSample: FieldDeclaration = { source: "native", strategy: "sample" }
const generateRequirements = ["RE-OUTCOME", "RE-STORED", "RE-GENERATED"]
const refusalRequirements = ["RE-OUTCOME", "RE-UNCHANGED"]

const reportOf = (reportId: string, startsAt: string, endsAt: string, currency: string, releasePolicy: string) => literal({ reportId, reportingPeriod: { startsAt, endsAt }, currency, releasePolicy })

const reversedReport = reportOf("acme-2026-q3-reversed", "2026-10-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z", "USD", "automatic")
const readerReport = reportOf("acme-2026-q3-reader", "2026-07-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "EUR", "operatorApproval")
const oneLine = literal([{ accountCode: "4000", description: "Consulting revenue", direction: "credit", amountMinor: 125_000 }])

const sampledInput: InputDeclaration = {
  id: "generate-sampled",
  operation,
  description: "Generate a report export whose report header (id, reporting period, currency, release policy) and ledger lines are drawn together from one native whole-payload sample",
  fields: { report: nativeSample, lines: nativeSample },
  validity: "native-valid",
  outcome: { kind: "accepted" },
}

const reversedInput: InputDeclaration = {
  id: "generate-reversed-period",
  operation,
  description: "Generate a report export for a reporting period that ends on 2026-07-01, three months before it starts on 2026-10-01, with one valid credit line",
  fields: { report: reversedReport, lines: oneLine },
  validity: "native-invalid",
  outcome: { kind: "rejected" },
}

const readerInput: InputDeclaration = {
  id: "generate-as-reader",
  operation,
  description: "Generate a well-formed third-quarter 2026 report export with one valid credit line while signed in as a reader, whom report generation is not granted to",
  fields: { report: readerReport, lines: oneLine },
  validity: "native-valid",
  outcome: { kind: "denied", failure: "Forbidden" },
}

const scenario = (id: string, story: string, actor: string, goal: string, input: InputDeclaration, requirements: ReadonlyArray<string>): ScenarioDeclaration => ({
  id,
  story,
  actor,
  fixture,
  goal,
  operations: [input.operation],
  inputs: [input],
  required: [input.id],
  observations: [],
  probes: [storedExports],
  requirements,
  reload: true,
})

export const reportExportsCatalog: Declaration = {
  id: "report-exports-generation",
  actors: [
    { id: editor, binding: "editor-session", description: "The seeded acme editor account alice, granted report generation." },
    { id: reader, binding: "reader-session", description: "The seeded acme reader account bob, without the editor role report generation requires." },
  ],
  requirements: [
    { id: "RE-OUTCOME", text: "The application answers each submitted export request with its declared outcome: acceptance, rejection by the native contract, or the Forbidden refusal.", evaluator: "declared-outcome" },
    { id: "RE-STORED", text: "An accepted export request is stored under the returned execution id holding every submitted value, nested report fields and every line included.", evaluator: "stored-request" },
    { id: "RE-GENERATED", text: "The submitted export request names only caller fields; the server-generated execution id and tenant never appear in the input.", evaluator: "generated-excluded" },
    { id: "RE-UNCHANGED", text: "A rejected or refused export request leaves every stored export request of the tenant unchanged.", evaluator: "store-unchanged" },
  ],
  stories: [
    { id: "keep-generated-export", text: "As an editor, I generate a report export and the application keeps exactly the request I entered.", actor: editor, requirements: generateRequirements },
    { id: "refuse-reversed-period", text: "As an editor, a report export whose reporting period ends before it starts is refused without storing anything.", actor: editor, requirements: refusalRequirements },
    { id: "refuse-reader-generation", text: "As a reader, I am refused when I try to generate a report export, and nothing is stored.", actor: reader, requirements: refusalRequirements },
  ],
  scenarios: [
    scenario("generate-sampled-export", "keep-generated-export", editor, "Open the Generate discard form, enter exactly the offered report and lines values, and submit them so that the export is accepted and its execution id returned, then reload the page.", sampledInput, generateRequirements),
    scenario("reversed-period-rejected", "refuse-reversed-period", editor, "Open the Generate discard form, enter exactly the offered report with its reversed reporting period and the offered lines, and submit them so that the application's rejection is observed, then reload the page.", reversedInput, refusalRequirements),
    scenario("reader-generation-denied", "refuse-reader-generation", reader, "Open the Generate discard form, enter exactly the offered report and lines values, and submit them so that the application's refusal of generation by a reader is observed, then reload the page.", readerInput, refusalRequirements),
  ],
}
