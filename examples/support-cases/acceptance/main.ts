import { Context, Effect, Layer } from "effect"
import { runAcceptanceCli } from "@effect-domains/acceptance/cli"
import { evidenceLayer } from "@effect-domains/acceptance/evidence"
import { inputLayer } from "@effect-domains/acceptance/inputs"
import { SupportCasesApplication } from "../application.ts"
import { definition, identity } from "./definition.ts"
import { evaluationLayer } from "./evaluation.ts"
import { fixtureLayer } from "./fixture.ts"

const help = `Support Cases slice: real Jev exploration and browser acceptance
bun run support-cases:acceptance [--output PATH] [--seed INTEGER] [--model ID]
  [--minimum-confidence 0..1] [--max-actions 1..100 (default 40)] [--deadline-seconds 1..600]
bun run support-cases:acceptance --replay PATH/run.json [--output PATH]

Nine catalog scenarios run through the generated application UI: a multi-step case
lifecycle (open, triage, assign to the on-duty agent, resolve, reopen, reload); four
native-valid policy denials (stale version, off-duty agent, missing assignment,
disallowed transition); one native-invalid rejection; and audit-trail reads by the
administrator (allowed), a reader (Forbidden) and a visitor (Unauthenticated). Jev chooses
each offered browser action toward the declared goal; candidate inputs come from prepared
fixtures, captured results, literals and native samples. Hidden case detail and audit
records are read through scoped fixture probes, and every requirement is evaluated
independently.

Exploration requires TYPESAFE_API_KEY. Replay uses captured concrete inputs/actions,
re-resolves fixture and captured identities, and rejects stale builds or catalogs. Every
scenario launches an isolated Support Cases server and a fresh Chromium context. Run
'bun run build' and 'bunx playwright install chromium' first. Evidence is local JSON +
screenshots/logs; it is scanned for fixture credentials and the API key, and any hit fails
the run. Nonzero exit: slice not passed, prerequisites failed, credential found in
evidence, or evidence could not be saved.
`

const evidence = evidenceLayer(identity)

// No published Support Cases payload codec needs a runtime service because every wire codec is pure.
const codecServices = Context.empty()

const inputs = inputLayer(SupportCasesApplication, codecServices)

const services = Layer.mergeAll(evidence, fixtureLayer, inputs, evaluationLayer)

const command = runAcceptanceCli(definition, services, help)

await Effect.runPromise(command)
