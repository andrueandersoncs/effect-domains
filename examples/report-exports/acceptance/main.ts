import { Effect, Layer } from "effect"
import { runAcceptanceCli } from "@effect-domains/acceptance/cli"
import { evidenceLayer } from "@effect-domains/acceptance/evidence"
import { inputLayer } from "@effect-domains/acceptance/inputs"
import { ReportExportsApplication } from "../application.ts"
import { definition, identity } from "./definition.ts"
import { codecServices, evaluationLayer } from "./evaluation.ts"
import { fixtureLayer } from "./fixture.ts"

const help = `Report Exports generation matrix: real Jev exploration and browser acceptance
bun run report-exports:acceptance [--output PATH] [--seed INTEGER] [--model ID]
  [--minimum-confidence 0..1] [--max-actions 1..100 (default 20)] [--deadline-seconds 1..600]
bun run report-exports:acceptance --replay PATH/run.json [--output PATH]

Three catalog scenarios run through the generated application UI against an isolated
Report Exports topology: the server as a cluster client plus one owned worker process as
a cluster runner, sharing private stores and a generated demo password (logs:
server.*.log, worker.*.log). The acme tenant already holds one accepted export, seeded by
the editor alice:
  generate-sampled-export   ReportExport.GenerateDiscard as alice with the report header
                            and lines drawn from one native whole-payload sample;
                            accepted with an execution id
  reversed-period-rejected  the same form as alice with a reporting period ending before
                            it starts, which the native codec rejects
  reader-generation-denied  the same form as the reader bob; refused with Forbidden
Plain evaluators judge the declared outcome, that an accepted request is stored under
the returned execution id with every submitted value (read by the fixture's
stored-exports probe of the isolated store), and that refusals leave the store unchanged.

Exploration requires TYPESAFE_API_KEY. Replay uses captured concrete inputs/actions and
rejects stale builds/specifications. Run 'bun run build' and
'bunx playwright install chromium' first. Evidence is private local JSON + screenshots/
logs; it is scanned for the API key, the demo password, and issued session tokens, and
any hit fails the run. Nonzero exit: a scenario did not pass, prerequisites failed, a
credential was found in evidence, or evidence could not be saved.
`

const evidence = evidenceLayer(identity)

const inputs = inputLayer(ReportExportsApplication, codecServices)

const services = Layer.mergeAll(evidence, fixtureLayer, inputs, evaluationLayer)

const command = runAcceptanceCli(definition, services, help)

await Effect.runPromise(command)
