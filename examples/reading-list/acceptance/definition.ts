import { Effect, Schema, flow } from "effect"
import { EvidenceIdentity } from "@effect-domains/acceptance/evidence"
import { EvidencePolicy, localRules } from "@effect-domains/acceptance/governance"
import { AcceptanceError } from "@effect-domains/acceptance/model"
import { platformObligations } from "@effect-domains/acceptance/obligations"
import type { QueryApplication } from "@effect-domains/acceptance/query"
import type { AcceptanceDefinition } from "@effect-domains/acceptance/runner"
import { ReadingListApplication } from "../application.ts"
import { readingListCatalog } from "./catalog.ts"
import { VerifierReport, evaluatorRevisions, verifyDefects } from "./evaluation.ts"
import { readingListFaults } from "./faults.ts"
import { fixtureLayer } from "./fixture.ts"

const verifierFailure = (error: Schema.SchemaError) => AcceptanceError.make({ boundary: "verifier", message: error.message })

const encodeVerifier = flow(Schema.encodeEffect(VerifierReport), Effect.mapError(verifierFailure))

const encodedVerifier = Effect.flatMap(verifyDefects, encodeVerifier)

const listOperation = (resource: string) => `${resource}.list`

// No probe or operation returns protected records because Reading List has no privileged actor; secrets are still always redacted.
const policy = EvidencePolicy.make({
  application: "reading-list",
  revision: "reading-list-evidence@1",
  scope: "local-only",
  protectedProbes: [],
  protectedOperations: [],
  rules: localRules,
})

export const definition: AcceptanceDefinition = {
  name: "reading-list",
  format: "reading-list-acceptance@2",
  title: "Reading List Slice A",
  catalog: readingListCatalog,
  catalogs: [platformObligations],
  application: ReadingListApplication,
  evaluators: evaluatorRevisions,
  advanced: ["SDA-01", "SDA-02", "SDA-03", "SDA-04", "SDA-05", "SDA-06", "SDA-07", "SDA-08", "SDA-09", "SDA-10", "SDA-12"],
  unexercised: ["SDA-11"],
  verifier: encodedVerifier,
  observationOperation: listOperation,
  submissionProbes: [],
  directProbes: [],
  defaultMaxActions: 30,
  faults: readingListFaults,
  policy,
  surfaces: [],
}

export const identity = EvidenceIdentity.make({
  name: "reading-list",
  application: ReadingListApplication,
  walkedRoots: ["packages/effect-domains/src", "packages/effect-domains-acceptance/src", "apps/application-ui/src", "examples/reading-list/acceptance", "examples/reading-list/migrations"],
  builtRoots: [],
  files: [
    "examples/reading-list/domain.ts",
    "examples/reading-list/resources.ts",
    "examples/reading-list/application.ts",
    "examples/reading-list/infrastructure.ts",
    "examples/reading-list/main.ts",
    "examples/reading-list/migrations.ts",
    "bun.lock",
    "package.json",
    "packages/effect-domains/package.json",
    "packages/effect-domains-acceptance/package.json",
    "examples/reading-list/package.json",
    "apps/application-ui/package.json",
    "apps/application-ui/assets.ts",
    "apps/application-ui/build.ts",
    "apps/application-ui/dist/client.js",
    "apps/application-ui/dist/style.css",
  ],
  effect: "4.0.0-rc.112",
})

/** Product queries read the same definition, build identity, and fixture bindings because a second catalog for consumers would drift from the executed one. */
export const queryApplication: QueryApplication = { definition, identity, fixtures: fixtureLayer }
