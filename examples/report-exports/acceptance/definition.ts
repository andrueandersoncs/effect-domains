import { EvidenceIdentity } from "@effect-domains/acceptance/evidence"
import type { AcceptanceDefinition } from "@effect-domains/acceptance/runner"
import { ReportExportsApplication } from "../application.ts"
import { reportExportsCatalog } from "./catalog.ts"
import { evaluators } from "./evaluation.ts"

export const listOperation = (resource: string) => `${resource}.list`

export const definition: AcceptanceDefinition = {
  name: "report-exports",
  title: "Report Exports generation matrix",
  catalog: reportExportsCatalog,
  application: ReportExportsApplication,
  evaluators,
  observationOperation: listOperation,
  submissionProbes: [],
  directProbes: [],
  defaultMaxActions: 20,
}

export const identity = EvidenceIdentity.make({
  name: "report-exports",
  application: ReportExportsApplication,
  walkedRoots: ["packages/effect-domains/src", "packages/effect-domains-acceptance/src", "apps/application-ui/src", "examples/report-exports/acceptance", "examples/report-exports/migrations", "packages/example-support/src"],
  builtRoots: ["apps/application-ui/dist"],
  files: [
    "examples/report-exports/application.ts",
    "examples/report-exports/audit.ts",
    "examples/report-exports/authorization.ts",
    "examples/report-exports/contracts.ts",
    "examples/report-exports/executions.ts",
    "examples/report-exports/main.ts",
    "examples/report-exports/migrations.ts",
    "examples/report-exports/output.ts",
    "examples/report-exports/runtime.ts",
    "examples/report-exports/subscriptions.ts",
    "examples/report-exports/workflow.ts",
    "examples/report-exports/writer.ts",
    "bun.lock",
    "package.json",
    "packages/effect-domains/package.json",
    "packages/effect-domains-acceptance/package.json",
    "packages/example-support/package.json",
    "examples/report-exports/package.json",
    "apps/application-ui/package.json",
    "apps/application-ui/assets.ts",
    "apps/application-ui/build.ts",
  ],
  effect: "4.0.0-rc.112",
})
