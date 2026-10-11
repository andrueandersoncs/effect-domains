import { Array } from "effect"
import { type Catalog, type Requirement, type Revision, qualified } from "@effect-domains/acceptance/model"

const provenance = "docs/wiki/story-driven-acceptance.md#ap-13-generation-and-captured-codec-coverage"
const completionProvenance = "docs/examples.md#report-exports and examples/report-exports/README.md#poll-and-release-as-the-operator"
const revision = "1"
const catalogRevision = "2"
const featureRevision = "2"
const catalogId = "report-exports-generation"
const approval = "approved"
const editor = "editor"
const reader = "reader"
const fixture = "acme-exports"
const operation = "ReportExport.GenerateDiscard"
const generate = "ReportExport.Generate"
const storedExports = "stored-exports"
const exportStatus = "export-status"

type Declaration = typeof Catalog.Encoded
type ScenarioDeclaration = Declaration["scenarios"][number]
type InputDeclaration = ScenarioDeclaration["inputs"][number]
type FieldDeclaration = InputDeclaration["fields"][string]

const literal = (value: unknown): FieldDeclaration => ({ source: "literal", value })
const nativeSample: FieldDeclaration = { source: "native", strategy: "sample" }
const accepted: InputDeclaration["outcome"] = { kind: "accepted" }
const rejected: InputDeclaration["outcome"] = { kind: "rejected" }
const forbidden: InputDeclaration["outcome"] = { kind: "denied", failure: "Forbidden" }
const generateRequirements = ["RE-OUTCOME", "RE-LOSSLESS", "RE-GENERATED"]
const refusalRequirements = ["RE-OUTCOME", "RE-UNCHANGED"]
const completionRequirements = ["RE-OUTCOME", "RE-GENERATED", "RE-COMPLETES"]

const reportOf = (reportId: string, startsAt: string, endsAt: string, currency: string, releasePolicy: string) => literal({ reportId, reportingPeriod: { startsAt, endsAt }, currency, releasePolicy })

const reversedReport = reportOf("acme-2026-q3-reversed", "2026-10-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z", "USD", "automatic")
const readerReport = reportOf("acme-2026-q3-reader", "2026-07-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "EUR", "operatorApproval")
const completionReport = reportOf("acme-2026-q4-completion", "2026-10-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z", "USD", "automatic")

const completionLines = literal([
  { accountCode: "4000", description: "Fourth-quarter consulting revenue", direction: "credit", amountMinor: 180_000 },
  { accountCode: "6100", description: "Fourth-quarter office supplies", direction: "debit", amountMinor: 12_500 },
  { accountCode: "4100", description: "Fourth-quarter training revenue", direction: "credit", amountMinor: 40_000 },
])

const oneLine = literal([{ accountCode: "4000", description: "Consulting revenue", direction: "credit", amountMinor: 125_000 }])

const sampledInput: InputDeclaration = {
  id: "generate-sampled",
  operation,
  description: "Generate a report export whose report header (id, reporting period, currency, release policy) and ledger lines are drawn together from one native whole-payload sample, so the nested period satisfies its start-before-end check and the lines are a non-empty array",
  fields: { report: nativeSample, lines: nativeSample },
  validity: "native-valid",
  outcome: accepted,
}

const reversedInput: InputDeclaration = {
  id: "generate-reversed-period",
  operation,
  description: "Generate a report export for a reporting period that ends on 2026-07-01, three months before it starts on 2026-10-01, with one valid credit line; the native reporting-period check rejects it",
  fields: { report: reversedReport, lines: oneLine },
  validity: "native-invalid",
  outcome: rejected,
}

const readerInput: InputDeclaration = {
  id: "generate-as-reader",
  operation,
  description: "Generate a well-formed third-quarter 2026 report export with one valid credit line while signed in as a reader, whom report generation is not granted to",
  fields: { report: readerReport, lines: oneLine },
  validity: "native-valid",
  outcome: forbidden,
}

const completionInput: InputDeclaration = {
  id: "generate-completes",
  operation: generate,
  description: "Generate a fourth-quarter 2026 USD report export with automatic release and three ledger lines (two credits and one debit) under a report id no earlier export used, and wait for the generated report result",
  fields: { report: completionReport, lines: completionLines },
  validity: "native-valid",
  outcome: accepted,
}

const scenario = (id: string, story: string, actor: string, goal: string, input: InputDeclaration, requirements: ReadonlyArray<string>): ScenarioDeclaration => ({
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
  observations: [],
  probes: [storedExports],
  requirements,
  assessments: [],
  reload: true,
})

const sampledScenario = scenario("generate-sampled-export", "keep-generated-export", editor, "Open the Generate discard form, enter exactly the offered report and lines values, and submit them so that the export is accepted and its execution id returned, then reload the page.", sampledInput, generateRequirements)
const reversedScenario = scenario("reversed-period-rejected", "refuse-reversed-period", editor, "Open the Generate discard form, enter exactly the offered report with its reversed reporting period and the offered lines, and submit them so that the application's rejection of input outside the native contract is observed, then reload the page.", reversedInput, refusalRequirements)

const completionWatch: ScenarioDeclaration["watch"] = {
  input: completionInput.id,
  probe: exportStatus,
  subject: "tenant.id",
  field: "_tag",
  terminal: ["Succeeded", "Failed", "Cancelled"],
  intervalMillis: 250,
  deadlineSeconds: 60,
  confirmations: 1,
}

const completionScenario: ScenarioDeclaration = {
  ...scenario("generate-export-completes", "await-completed-export", editor, "Open the Generate form, enter exactly the offered report and lines values, and submit them so that the export is generated and its completed report result returned, then reload the page.", completionInput, completionRequirements),
  provenance: completionProvenance,
  watch: completionWatch,
}

const readerScenario = scenario("reader-generation-denied", "refuse-reader-generation", reader, "Open the Generate discard form, enter exactly the offered report and lines values, and submit them so that the application's refusal of generation by a reader is observed, then reload the page.", readerInput, refusalRequirements)

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

const outcomeRequirement = requirement("RE-OUTCOME", "Each submitted export request is exactly the approved candidate, the exact native codec judges it as declared, and the application answers with the declared outcome: acceptance, rejection by the native contract, or the declared Forbidden refusal.", "declared-outcome", "behavior")
const losslessRequirement = requirement("RE-LOSSLESS", "An accepted export request decodes and re-encodes through the native codec without loss, and the request the application stored for the returned execution id contains every submitted value exactly, nested report fields and every line included.", "lossless-roundtrip", "behavior")
const generatedRequirement = requirement("RE-GENERATED", "The submitted export request names only caller fields; the server-generated execution id and tenant never appear in the input.", "generated-excluded", "behavior")

const completesRequirement: Declaration["requirements"][number] = {
  ...requirement("RE-COMPLETES", "Acceptance of an automatic export is not its completion: within the declared deadline the operator poll of its one new execution rises monotonically through the documented stages (accepted, dispatched, writing) to Succeeded, never Failed or Cancelled, and the immutable artifact the result names holds exactly the submitted report and lines, separate debit and credit totals, an automatic release with no releaser, and the values the Succeeded result and the generating response report, with the same path and bytes on a confirming poll.", "eventual-completion", "behavior"),
  provenance: completionProvenance,
}

const unchangedRequirement: Declaration["requirements"][number] = {
  ...requirement("RE-UNCHANGED", "A rejected or refused export request leaves every stored export request of the tenant exactly unchanged.", "observation-unchanged", "preservation"),
  refines: { requirement: "platform:PLATFORM-PRESERVE", arguments: { scope: "every stored export request of the acme tenant" } },
}

const actors: Declaration["actors"] = [
  { id: editor, revision, provenance, approval, binding: "editor-session", description: "The seeded acme editor account alice, granted report generation; the harness resolves its session, which is never model-visible." },
  { id: reader, revision, provenance, approval, binding: "reader-session", description: "The seeded acme reader account bob, without the editor role report generation requires." },
]

const contexts: Declaration["contexts"] = [
  { id: "seeded-export", revision, provenance, approval, narrative: "The acme tenant holds an entitlement to generate reports and has already accepted one third-quarter export.", fixtures: [fixture] },
  { id: "export-worker-running", revision, provenance: completionProvenance, approval, narrative: "The acme tenant holds an entitlement to generate reports and has already accepted one third-quarter export, and a separate worker process executes accepted exports durably beside the application server.", fixtures: [fixture] },
]

const needs: Declaration["needs"] = [
  { id: "export-financial-reports", revision, provenance, approval, text: "Produce durable financial report exports exactly as requested, and only by people allowed to generate them." },
]

const capabilities: Declaration["capabilities"] = [
  { id: "generate-export", revision, provenance, approval, resource: "report_export_executions", operations: [operation] },
  { id: "complete-export", revision, provenance: completionProvenance, approval, resource: "report_export_executions", operations: [generate] },
]

const features: Declaration["features"] = [
  { id: "report-exports", revision: featureRevision, provenance, approval, title: "Report exports", capabilities: ["generate-export", "complete-export"] },
]

const requirements = [outcomeRequirement, losslessRequirement, generatedRequirement, unchangedRequirement, completesRequirement]

const stories: Declaration["stories"] = [
  { id: "keep-generated-export", revision, provenance, approval, original: "As an editor, I want to generate a report export with its reporting period, currency, release policy, and ledger lines so that the application keeps exactly the request I entered.", actor: editor, context: "seeded-export", need: "export-financial-reports", capabilities: ["generate-export"], requirements: generateRequirements, nonGoals: ["Artifact contents", "Release approval", "Polling"], openDecisions: [] },
  { id: "refuse-reversed-period", revision, provenance, approval, original: "As an editor, I want a report export whose reporting period ends before it starts refused without storing anything.", actor: editor, context: "seeded-export", need: "export-financial-reports", capabilities: ["generate-export"], requirements: refusalRequirements, nonGoals: ["Period auto-correction"], openDecisions: [] },
  { id: "refuse-reader-generation", revision, provenance, approval, original: "As a reader, I am refused when I try to generate a report export, and nothing is stored.", actor: reader, context: "seeded-export", need: "export-financial-reports", capabilities: ["generate-export"], requirements: refusalRequirements, nonGoals: ["Role administration"], openDecisions: [] },
  { id: "await-completed-export", revision, provenance: completionProvenance, approval, original: "As an editor, I want an automatic report export I generate to complete with an immutable artifact holding exactly the report and lines I entered, so that I rely on the finished file rather than on its acceptance.", actor: editor, context: "export-worker-running", need: "export-financial-reports", capabilities: ["complete-export"], requirements: completionRequirements, nonGoals: ["Release approval", "Cancellation", "Resuming a suspended execution"], openDecisions: [] },
]

const scenarios = [sampledScenario, reversedScenario, readerScenario, completionScenario]
const generationDeclarations: ReadonlyArray<Revision> = [...actors, ...needs, outcomeRequirement, losslessRequirement, generatedRequirement, unchangedRequirement, sampledScenario, reversedScenario, readerScenario]
const generationContexts = Array.take(contexts, 1)
const generationCapabilities = Array.take(capabilities, 1)
const generationStories = Array.take(stories, 3)
const generationQualified = Array.map([...generationDeclarations, ...generationContexts, ...generationCapabilities, ...generationStories], qualified)
const generationApprovals = [`${catalogId}@${revision}`, `report-exports@${revision}`, ...generationQualified]
const completionDeclarations: ReadonlyArray<Revision> = [{ id: catalogId, revision: catalogRevision, provenance, approval }, ...features, completesRequirement, completionScenario]
const completionContexts = Array.drop(contexts, 1)
const completionCapabilities = Array.drop(capabilities, 1)
const completionStories = Array.drop(stories, 3)
const completionApprovals = Array.map([...completionDeclarations, ...completionContexts, ...completionCapabilities, ...completionStories], qualified)

const approvals: Declaration["approvals"] = [{
  id: "report-exports-generation-approval",
  by: "implementation agent under the user-approved AP-13 generation-matrix package",
  on: "2026-10-10",
  basis: "AP-13 of docs/wiki/story-driven-acceptance.md and the live probe of examples/report-exports: ReportExport.GenerateDiscard decodes the nested ReportExportRequest schema (branded report id pattern, reporting period with a start-before-end check, currency and release-policy enums, non-empty lines), returns an execution id and stores the request in report_export_executions; a reversed period is rejected by the codec with HTTP 400, and the reader bob is refused with Forbidden.",
  approves: generationApprovals,
}, {
  id: "report-exports-completion-approval",
  by: "implementation agent deriving from documented policy (not a user approval)",
  on: "2026-10-10",
  basis: "AP-15 of docs/wiki/story-driven-acceptance.md binds documented completion policy. docs/examples.md (Report exports): \"Acceptance writes an application outbox row; it is not completion. Wait for `Succeeded` and inspect the returned artifact path.\" examples/report-exports/README.md: GenerateDiscard means durably accepted, not completed, and polling distinguishes Pending stage accepted, dispatched, and writing from Succeeded, recorded only after the durable artifact result; Keep polling until the result has _tag Succeeded, then open the returned artifactPath, whose JSON has report, release, lines, and totals keys with debit and credit kept separate; artifact writing creates <REPORT_EXPORTS_OUTPUT_DIR>/<executionId>.json atomically and never overwrites it (immutable); an automatic artifact has releasedBy null; ReportExport.Generate returns the report result directly without Poll's _tag wrapper; Poll is an operator operation. The catalog and the Report exports feature changed only to add the complete-export capability, its story, context, requirement, and scenario; the AP-13 generation obligations are unchanged. No controlled clock is needed: the documented five-second durable delay is real and completes well inside the declared 60-second watch deadline, so no production clock or fault switch is used.",
  approves: completionApprovals,
}]

export const reportExportsCatalog: Declaration = {
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
  textFixtures: [],
  requirements,
  stories,
  scenarios,
  rubrics: [],
}
