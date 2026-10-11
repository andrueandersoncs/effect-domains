import { EvidenceIdentity } from "@effect-domains/acceptance/evidence"
import { EvidencePolicy, localRules } from "@effect-domains/acceptance/governance"
import { platformObligations } from "@effect-domains/acceptance/obligations"
import type { QueryApplication } from "@effect-domains/acceptance/query"
import { roundTripEvaluators, roundTripVerifier } from "@effect-domains/acceptance/roundtrip"
import type { AcceptanceDefinition } from "@effect-domains/acceptance/runner"
import { ExpenseLedgerApplication } from "../application.ts"
import { expenseLedgerCatalog } from "./catalog.ts"
import { fixtureLayer } from "./fixture.ts"

const listOperation = (resource: string) => `${resource}.list`

// No probe or operation returns protected records because the ledger is public and has no privileged actor; secrets are still always redacted.
const policy = EvidencePolicy.make({
  application: "expense-ledger",
  revision: "expense-ledger-evidence@1",
  scope: "local-only",
  protectedProbes: [],
  protectedOperations: [],
  rules: localRules,
})

export const definition: AcceptanceDefinition = {
  name: "expense-ledger",
  format: "expense-ledger-acceptance@1",
  title: "Expense Ledger generation matrix",
  catalog: expenseLedgerCatalog,
  catalogs: [platformObligations],
  application: ExpenseLedgerApplication,
  evaluators: roundTripEvaluators,
  advanced: ["SDA-02", "SDA-06"],
  unexercised: ["SDA-01", "SDA-03", "SDA-04", "SDA-05", "SDA-07", "SDA-08", "SDA-09", "SDA-10", "SDA-11", "SDA-12"],
  verifier: roundTripVerifier,
  observationOperation: listOperation,
  submissionProbes: [],
  directProbes: [],
  defaultMaxActions: 20,
  faults: [],
  policy,
  surfaces: [],
}

export const identity = EvidenceIdentity.make({
  name: "expense-ledger",
  application: ExpenseLedgerApplication,
  walkedRoots: ["packages/effect-domains/src", "packages/effect-domains-acceptance/src", "apps/application-ui/src", "examples/expense-ledger/acceptance", "examples/expense-ledger/migrations"],
  builtRoots: ["apps/application-ui/dist"],
  files: [
    "examples/expense-ledger/application.ts",
    "examples/expense-ledger/domain.ts",
    "examples/expense-ledger/main.ts",
    "examples/expense-ledger/migrations.ts",
    "examples/expense-ledger/resources.ts",
    "examples/expense-ledger/sqlite.ts",
    "bun.lock",
    "package.json",
    "packages/effect-domains/package.json",
    "packages/effect-domains-acceptance/package.json",
    "examples/expense-ledger/package.json",
    "apps/application-ui/package.json",
    "apps/application-ui/assets.ts",
    "apps/application-ui/build.ts",
  ],
  effect: "4.0.0-rc.112",
})

/** Product queries read the same definition, build identity, and fixture bindings because a second catalog for consumers would drift from the executed one. */
export const queryApplication: QueryApplication = { definition, identity, fixtures: fixtureLayer }
