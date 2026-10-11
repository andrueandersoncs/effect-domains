import { Context, Effect, Layer } from "effect"
import { runAcceptanceCli } from "@effect-domains/acceptance/cli"
import { evidenceLayer } from "@effect-domains/acceptance/evidence"
import { inputLayer } from "@effect-domains/acceptance/inputs"
import { ReadingListApplication } from "../application.ts"
import { definition, identity } from "./definition.ts"
import { evaluationLayer } from "./evaluation.ts"
import { fixtureLayer } from "./fixture.ts"

const help = `Reading List Slice A: real Jev exploration and browser acceptance
bun run reading-list:acceptance [--output PATH] [--seed INTEGER] [--model ID]
  [--minimum-confidence 0..1] [--max-actions 1..100 (default 30)] [--deadline-seconds 1..600]
bun run reading-list:acceptance --replay PATH/run.json [--output PATH]
  [--repair-locators] [--fault FAULT-ID]   (no custom surfaces: nothing is repairable)
bun run reading-list:acceptance --faults [--output PATH] [--seed INTEGER] [--model ID]

Nine catalog scenarios run through the generated application UI, each with one
declared input case: three book creations (native sample, null, and omitted rating)
and six rating updates of a prepared planned book (native minimum, maximum, and null
accepted; below, above, and fractional rejected). Jev chooses each offered browser
action toward the declared goal; candidate inputs come from prepared fixture facts,
approved text, and native strategies, and every requirement is evaluated
independently against the before and reloaded after Books views.

Exploration requires TYPESAFE_API_KEY. Replay uses captured concrete inputs/actions,
re-resolves fixture identities, and rejects stale builds/specifications rather than
repairing or skipping obligations. Every scenario launches an isolated actual Reading
List server and a fresh Chromium context. Run 'bun run build' and
'bunx playwright install chromium' first. Evidence is private local JSON +
screenshots/logs, not production-safe data; it is scanned for the API key, and any
hit fails the run. Nonzero exit: Slice A not passed, prerequisites failed, credential
found in evidence, or evidence could not be saved.

--faults runs real Jev explorations against labeled defective implementations and
execution controls. Each fault starts its scenario's isolated server behind a scoped
local proxy (no production fault switch): create without write, update lost after
reload, update applied to the sentinel, rejected update that still mutates, and
create that mutates the sentinel; plus deadline (5 s call delay, 4 s deadline),
action-limit (2 actions), racing-target (submit attributes mutate every 250 ms) and
disabled-submit controls. Each distinct fault scenario also runs once without a
proxy as a clean control. Evidence: <output>/<fault-id>/, <output>/clean/<scenario>/
and <output>/faults.json. Exit 0 only when every defect fails each affected
requirement, no control passes any requirement and each records its interruption,
and every clean control passes. Zero false acceptance on this finite set is not a
universal reliability claim.
All SDA completion entries remain open; this is internally guided functional QA.

Evidence policy reading-list-evidence@1 (local-only): each run claims its output with
.acceptance-owner.json and ends with lineage.json. Inspect, export, or prune with
'bun run acceptance:evidence --help'.
`

const evidence = evidenceLayer(identity)

// No published Reading List payload codec needs a runtime service because every wire codec is pure.
const codecServices = Context.empty()

const inputs = inputLayer(ReadingListApplication, codecServices)

const services = Layer.mergeAll(evidence, fixtureLayer, inputs, evaluationLayer)

const command = runAcceptanceCli(definition, services, help)

await Effect.runPromise(command)
