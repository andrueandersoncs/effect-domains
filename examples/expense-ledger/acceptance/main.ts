import { Context, Effect, Layer } from "effect"
import { runAcceptanceCli } from "@effect-domains/acceptance/cli"
import { EvidenceIdentity, evidenceLayer } from "@effect-domains/acceptance/evidence"
import { inputLayer } from "@effect-domains/acceptance/inputs"
import type { AcceptanceDefinition } from "@effect-domains/acceptance/runner"
import { ExpenseLedgerApplication } from "../application.ts"
import { expenseLedgerCatalog, listOperation } from "./catalog.ts"
import { evaluationLayer, evaluators } from "./evaluation.ts"
import { fixtureLayer } from "./fixture.ts"

const help = `Expense Ledger generation matrix: real Jev exploration and browser acceptance
bun run expense-ledger:acceptance [--output PATH] [--seed INTEGER] [--model ID]
  [--minimum-confidence 0..1] [--max-actions 1..100 (default 20)] [--deadline-seconds 1..600]
bun run expense-ledger:acceptance --replay PATH/run.json [--output PATH]

Three catalog scenarios run through the generated application UI against an isolated
actual Expense Ledger server seeded with a two-day period of two expenses:
  record-sampled-expense       expenses.record dated by the fixture's period start, a fixed
                               merchant, and category, amount, and currency drawn from one
                               native whole-payload sample; accepted
  lowercase-currency-rejected  the same form with the literal currency usd, which the
                               native currency pattern rejects (HTTP 400)
  reversed-totals-denied       expenses.totals with the fixture's period bounds swapped;
                               native-valid, refused by the handler with
                               InvalidExpenseDateRange (HTTP 422)
Plain evaluators judge each scenario: declared outcome, the recorded expense echoing every
submitted value, and an unchanged reloaded Expenses view for refusals.

Exploration requires TYPESAFE_API_KEY. Replay uses captured concrete inputs/actions and
rejects stale builds/specifications. Run 'bun run build' and
'bunx playwright install chromium' first. Evidence is local JSON + screenshots/logs; it is
scanned for the API key, and any hit fails the run. Nonzero exit: the generation matrix
did not pass, prerequisites failed, a credential was found in evidence, or evidence could
not be saved.
`

const definition: AcceptanceDefinition = {
  name: "expense-ledger",
  title: "Expense Ledger generation matrix",
  catalog: expenseLedgerCatalog,
  application: ExpenseLedgerApplication,
  evaluators,
  observationOperation: listOperation,
  submissionProbes: [],
  directProbes: [],
  defaultMaxActions: 20,
}

const identity = EvidenceIdentity.make({
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

// No published Expense Ledger payload codec needs a runtime service because every wire codec is pure.
const codecServices = Context.empty()

const inputs = inputLayer(ExpenseLedgerApplication, codecServices)

const evidence = evidenceLayer(identity)

const services = Layer.mergeAll(evidence, fixtureLayer, inputs, evaluationLayer)

const command = runAcceptanceCli(definition, services, help)

await Effect.runPromise(command)
