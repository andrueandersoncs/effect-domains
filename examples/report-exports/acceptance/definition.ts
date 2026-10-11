import { EvidenceIdentity } from "@effect-domains/acceptance/evidence"
import { EvidencePolicy, localRules } from "@effect-domains/acceptance/governance"
import { platformObligations } from "@effect-domains/acceptance/obligations"
import type { QueryApplication } from "@effect-domains/acceptance/query"
import type { AcceptanceDefinition } from "@effect-domains/acceptance/runner"
import { ReportExportsApplication } from "../application.ts"
import { reportExportsCatalog } from "./catalog.ts"
import { evaluatorRevisions, verifier } from "./evaluation.ts"
import { fixtureLayer } from "./fixture.ts"

const listOperation = (resource: string) => `${resource}.list`

// The stored-exports and export-status probes are unprotected because they return only synthetic export requests, operator poll results, and artifacts of the fixture tenant, which its editor submitted; secrets are still always redacted.
const policy = EvidencePolicy.make({
  application: "report-exports",
  revision: "report-exports-evidence@1",
  scope: "local-only",
  protectedProbes: [],
  protectedOperations: [],
  rules: localRules,
})

export const definition: AcceptanceDefinition = {
  name: "report-exports",
  format: "report-exports-acceptance@1",
  title: "Report Exports generation matrix",
  catalog: reportExportsCatalog,
  catalogs: [platformObligations],
  application: ReportExportsApplication,
  evaluators: evaluatorRevisions,
  advanced: ["SDA-02", "SDA-03", "SDA-06", "SDA-07"],
  unexercised: ["SDA-01", "SDA-04", "SDA-05", "SDA-08", "SDA-09", "SDA-10", "SDA-11", "SDA-12"],
  verifier,
  observationOperation: listOperation,
  submissionProbes: [],
  directProbes: [],
  defaultMaxActions: 20,
  faults: [],
  policy,
  surfaces: [],
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

/** Product queries read the same definition, build identity, and fixture bindings because a second catalog for consumers would drift from the executed one. */
export const queryApplication: QueryApplication = { definition, identity, fixtures: fixtureLayer }
