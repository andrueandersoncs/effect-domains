import { Context, Effect, Layer } from "effect"
import { runAcceptanceCli } from "@effect-domains/acceptance/cli"
import { evidenceLayer } from "@effect-domains/acceptance/evidence"
import { inputLayer } from "@effect-domains/acceptance/inputs"
import { roundTripLayer } from "@effect-domains/acceptance/roundtrip"
import { ExpenseLedgerApplication } from "../application.ts"
import { definition, identity } from "./definition.ts"
import { fixtureLayer } from "./fixture.ts"

const help = `Expense Ledger generation matrix (AP-13): real Jev exploration and browser acceptance
bun run expense-ledger:acceptance [--output PATH] [--seed INTEGER] [--model ID]
  [--minimum-confidence 0..1] [--max-actions 1..100 (default 20)] [--deadline-seconds 1..600]
bun run expense-ledger:acceptance --replay PATH/run.json [--output PATH]
  [--repair-locators]   (no custom surfaces: nothing is repairable)

Three catalog scenarios run through the generated application UI against an isolated
actual Expense Ledger server seeded with a two-day period of two expenses:
  record-sampled-expense       expenses.record dated by the fixture's period start, the
                               approved merchant text, and category, amount, and currency
                               drawn from one native whole-payload sample; accepted
  lowercase-currency-rejected  the same form with the literal currency usd, which the
                               native currency pattern rejects (HTTP 400)
  reversed-totals-denied       expenses.totals with the fixture's period bounds swapped;
                               native-valid, refused by the handler with
                               InvalidExpenseDateRange (HTTP 422)
Generic round-trip evaluators judge each scenario: declared outcome, lossless native
round trip with the recorded expense echoing every submitted value, exclusion of the
server-generated id, and unchanged reloaded Expenses view for refusals. A constructed
round-trip verifier must report zero false verdicts for a run to pass.

Exploration requires TYPESAFE_API_KEY. Replay uses captured concrete inputs/actions and
rejects stale builds/specifications. Run 'bun run build' and
'bunx playwright install chromium' first. Evidence is private local JSON + screenshots/
logs; it is scanned for the API key, and any hit fails the run. Nonzero exit: the
generation matrix did not pass, prerequisites failed, a credential was found in
evidence, or evidence could not be saved. This application declares no fault catalog.

Evidence policy expense-ledger-evidence@1 (local-only): each run claims its output with
.acceptance-owner.json and ends with lineage.json. Inspect, export, or prune with
'bun run acceptance:evidence --help'.
`

const evidence = evidenceLayer(identity)

// No published Expense Ledger payload codec needs a runtime service because every wire codec is pure.
const codecServices = Context.empty()

const inputs = inputLayer(ExpenseLedgerApplication, codecServices)

const evaluation = roundTripLayer(ExpenseLedgerApplication, codecServices)

const services = Layer.mergeAll(evidence, fixtureLayer, inputs, evaluation)

const command = runAcceptanceCli(definition, services, help)

await Effect.runPromise(command)
