import { Effect, Layer } from "effect"
import { runAcceptanceCli } from "@effect-domains/acceptance/cli"
import { evidenceLayer } from "@effect-domains/acceptance/evidence"
import { inputLayer } from "@effect-domains/acceptance/inputs"
import { ReportExportsApplication } from "../application.ts"
import { definition, identity } from "./definition.ts"
import { codecServices, evaluationLayer } from "./evaluation.ts"
import { fixtureLayer } from "./fixture.ts"

const help = `Report Exports generation matrix and eventual completion (AP-13, AP-15): real Jev
exploration and browser acceptance
bun run report-exports:acceptance [--output PATH] [--seed INTEGER] [--model ID]
  [--minimum-confidence 0..1] [--max-actions 1..100 (default 20)] [--deadline-seconds 1..600]
bun run report-exports:acceptance --replay PATH/run.json [--output PATH]
  [--repair-locators]   (no custom surfaces: nothing is repairable)

Four catalog scenarios run through the generated application UI against an isolated
actual Report Exports topology: the server as a cluster client plus one owned worker
process as a cluster runner, sharing private stores and a generated demo password (logs:
server.*.log, worker.*.log). The acme tenant already holds one accepted export, seeded by
the editor alice:
  generate-sampled-export   ReportExport.GenerateDiscard as alice with the nested report
                            header and the lines array drawn from one native
                            whole-payload sample; accepted with an execution id
  reversed-period-rejected  the same form as alice with a literal reporting period
                            ending before it starts, which the native codec rejects
                            (HTTP 400)
  reader-generation-denied  the same form as the reader bob with a well-formed literal
                            request; refused by the handler with Forbidden
  generate-export-completes ReportExport.Generate as alice with a literal automatic
                            export (fresh report id, three lines); a declared watch
                            polls the export-status probe every 250 ms for up to 60 s
                            plus one confirming poll after a terminal state
Generic round-trip evaluators judge each scenario: declared outcome, lossless native
round trip with the stored request of the returned execution id (read by the fixture's
stored-exports probe of the isolated store) holding every submitted value, exclusion
of server-generated fields, and an unchanged stored-exports probe for refusals.
The application-owned eventual-completion evaluator judges RE-COMPLETES over the watch:
the export-status probe discovers the one execution created after preparation and polls
it as the operator admin, retaining a copy of the Succeeded artifact's bytes (with its
SHA-256) in the scenario artifacts. Deadline expiry or missing observations are
inconclusive; Failed, Cancelled, ambiguous discovery, or a non-monotone status sequence
fail; Succeeded passes only when the artifact bytes match their hash, hold exactly the
submitted report and lines, separate debit/credit totals, and an automatic release with
no releaser, agree with the Succeeded result and the generating response, and are
unchanged on the confirming poll. No controlled clock is used: the workflow's real
five-second durable delay completes inside the declared deadline. A verifier of
constructed round-trip and eventual-completion controls must report zero false verdicts
for a run to pass.

Exploration requires TYPESAFE_API_KEY. Replay uses captured concrete inputs/actions and
rejects stale builds/specifications. Run 'bun run build' and
'bunx playwright install chromium' first. Evidence is private local JSON + screenshots/
logs; it is scanned for the API key, the demo password, and issued session tokens, and
any hit fails the run. Nonzero exit: the generation matrix did not pass, prerequisites
failed, a credential was found in evidence, or evidence could not be saved. This
application declares no fault catalog.

Evidence policy report-exports-evidence@1 (local-only): each run claims its output with
.acceptance-owner.json and ends with lineage.json. Inspect, export, or prune with
'bun run acceptance:evidence --help'.
`

const evidence = evidenceLayer(identity)

const inputs = inputLayer(ReportExportsApplication, codecServices)

const services = Layer.mergeAll(evidence, fixtureLayer, inputs, evaluationLayer)

const command = runAcceptanceCli(definition, services, help)

await Effect.runPromise(command)
