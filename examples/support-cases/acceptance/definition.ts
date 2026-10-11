import { Effect, Schema, flow } from "effect"
import { EvidenceIdentity } from "@effect-domains/acceptance/evidence"
import { EvidencePolicy, ProtectedOperation, ProtectedProbe, localRules } from "@effect-domains/acceptance/governance"
import { AcceptanceError } from "@effect-domains/acceptance/model"
import { platformObligations } from "@effect-domains/acceptance/obligations"
import type { QueryApplication } from "@effect-domains/acceptance/query"
import type { AcceptanceDefinition } from "@effect-domains/acceptance/runner"
import { SupportCasesApplication } from "../application.ts"
import { supportCasesCatalog } from "./catalog.ts"
import { VerifierReport, evaluatorRevisions, verifyDefects } from "./evaluation.ts"
import { supportCasesFaults } from "./faults.ts"
import { deskBinding } from "./desk.ts"
import { fixtureLayer } from "./fixture.ts"

const verifierFailure = (error: Schema.SchemaError) => AcceptanceError.make({ boundary: "verifier", message: error.message })

const encodeVerifier = flow(Schema.encodeEffect(VerifierReport), Effect.mapError(verifierFailure))

const encodedVerifier = Effect.flatMap(verifyDefects, encodeVerifier)

const listOperation = (resource: string) => `${resource}.list`

const auditReason = "Administrator-only lifecycle audit records; the fixture probe reads them for unrelated subjects such as the sentinel case"

const auditTrailProbe = ProtectedProbe.make({ probe: "audit-trail", identity: "id", reason: auditReason })

const auditTrailOperation = ProtectedOperation.make({ operation: "support.auditTrail", identity: "id", reason: auditReason })

// Audit-trail results are protected because they are readable only with the administrator session, which ordinary consumers never hold.
const policy = EvidencePolicy.make({
  application: "support-cases",
  revision: "support-cases-evidence@1",
  scope: "local-only",
  protectedProbes: [auditTrailProbe],
  protectedOperations: [auditTrailOperation],
  rules: localRules,
})

export const definition: AcceptanceDefinition = {
  name: "support-cases",
  format: "support-cases-acceptance@1",
  title: "Support Cases",
  catalog: supportCasesCatalog,
  catalogs: [platformObligations],
  application: SupportCasesApplication,
  evaluators: evaluatorRevisions,
  advanced: ["SDA-01", "SDA-02", "SDA-03", "SDA-04", "SDA-05", "SDA-06", "SDA-07", "SDA-08", "SDA-09", "SDA-10", "SDA-12"],
  unexercised: ["SDA-11"],
  verifier: encodedVerifier,
  observationOperation: listOperation,
  submissionProbes: ["case-detail"],
  directProbes: ["support.auditTrail"],
  defaultMaxActions: 40,
  faults: supportCasesFaults,
  policy,
  surfaces: [deskBinding],
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
    "examples/support-cases/desk.ts",
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

/** Product queries read the same definition, build identity, and fixture bindings because a second catalog for consumers would drift from the executed one. */
export const queryApplication: QueryApplication = { definition, identity, fixtures: fixtureLayer }
