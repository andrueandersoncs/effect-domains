import { EvidenceIdentity } from "@effect-domains/acceptance/evidence"
import type { AcceptanceDefinition } from "@effect-domains/acceptance/runner"
import { SupportCasesApplication } from "../application.ts"
import { supportCasesCatalog } from "./catalog.ts"
import { evaluatorNames } from "./evaluation.ts"

const listOperation = (resource: string) => `${resource}.list`

export const definition: AcceptanceDefinition = {
  name: "support-cases",
  title: "Support Cases",
  catalog: supportCasesCatalog,
  application: SupportCasesApplication,
  evaluators: evaluatorNames,
  observationOperation: listOperation,
  submissionProbes: ["case-detail"],
  directProbes: ["support.auditTrail"],
  defaultMaxActions: 40,
}

export const identity = EvidenceIdentity.make({
  name: "support-cases",
  application: SupportCasesApplication,
  walkedRoots: ["packages/effect-domains/src", "packages/effect-domains-acceptance/src", "apps/application-ui/src", "examples/support-cases/acceptance", "examples/support-cases/migrations", "packages/example-support/src"],
  builtRoots: ["apps/application-ui/dist"],
  files: [
    "examples/support-cases/application.ts",
    "examples/support-cases/audit.ts",
    "examples/support-cases/board.ts",
    "examples/support-cases/contracts.ts",
    "examples/support-cases/domain.ts",
    "examples/support-cases/main.ts",
    "examples/support-cases/migrations.ts",
    "examples/support-cases/resources.ts",
    "examples/support-cases/sqlite.ts",
    "bun.lock",
    "package.json",
    "packages/effect-domains/package.json",
    "packages/effect-domains-acceptance/package.json",
    "packages/example-support/package.json",
    "examples/support-cases/package.json",
    "apps/application-ui/package.json",
    "apps/application-ui/assets.ts",
    "apps/application-ui/build.ts",
  ],
  effect: "4.0.0-rc.112",
})
