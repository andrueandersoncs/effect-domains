import { Context, Effect, Layer } from "effect"
import { runAcceptanceCli } from "@effect-domains/acceptance/cli"
import { EvidenceIdentity, evidenceLayer } from "@effect-domains/acceptance/evidence"
import { inputLayer } from "@effect-domains/acceptance/inputs"
import type { AcceptanceDefinition } from "@effect-domains/acceptance/runner"
import { ReadingListApplication } from "../application.ts"
import { observationOperation, readingListCatalog } from "./catalog.ts"
import { evaluationLayer, evaluatorNames } from "./evaluation.ts"
import { fixtureLayer } from "./fixture.ts"

const definition: AcceptanceDefinition = {
  name: "reading-list",
  title: "Reading List",
  catalog: readingListCatalog,
  application: ReadingListApplication,
  evaluators: evaluatorNames,
  observationOperation,
  submissionProbes: [],
  directProbes: [],
  defaultMaxActions: 30,
}

const identity = EvidenceIdentity.make({
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

const help = `Reading List: real Jev exploration and browser acceptance
bun run reading-list:acceptance [--output PATH] [--seed INTEGER] [--model ID]
  [--minimum-confidence 0..1] [--max-actions 1..100 (default 30)] [--deadline-seconds 1..600]
bun run reading-list:acceptance --replay PATH/run.json [--output PATH]

Nine catalog scenarios run through the generated application UI, each with one
declared input case: three book creations (native sample, null, and omitted rating)
and six rating updates of a prepared planned book (native minimum, maximum, and null
accepted; below, above, and fractional rejected). Jev chooses each offered browser
action toward the declared goal; candidate inputs come from prepared fixture facts,
literal values, and native strategies, and every requirement is evaluated
independently against the before and reloaded after Books views.

Exploration requires TYPESAFE_API_KEY. Replay uses captured concrete inputs/actions,
re-resolves fixture identities, and rejects stale builds/specifications. Every
scenario launches an isolated actual Reading List server and a fresh Chromium
context. Run 'bun run build' and 'bunx playwright install chromium' first. Evidence
is local JSON + screenshots/logs; it is scanned for the API key, and any hit fails
the run. Nonzero exit: not passed, prerequisites failed, credential found in
evidence, or evidence could not be saved.
`

const evidence = evidenceLayer(identity)

// No published Reading List payload codec needs a runtime service because every wire codec is pure.
const codecServices = Context.empty()

const inputs = inputLayer(ReadingListApplication, codecServices)

const services = Layer.mergeAll(evidence, fixtureLayer, inputs, evaluationLayer)

const command = runAcceptanceCli(definition, services, help)

await Effect.runPromise(command)
