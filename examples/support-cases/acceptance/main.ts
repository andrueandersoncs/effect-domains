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
  [--repair-locators] [--fault FAULT-ID]
bun run support-cases:acceptance --faults [--output PATH] [--seed INTEGER] [--model ID]

Thirteen catalog scenarios: twelve run through the generated application UI (a multi-step
case lifecycle: open, triage, assign to the on-duty agent, resolve, reopen, reload; four
native-valid policy denials: stale version, off-duty agent, missing assignment,
disallowed transition; one native-invalid rejection; audit-trail reads by the
administrator (allowed), a reader (Forbidden) and a visitor (Unauthenticated); and three
version-race rounds race-round-1..3), and desk-triage-assign runs through the authored
support desk (/desk) via its explicit custom-UI binding: rows bound by case identity,
never by position. Each race round prepares a fresh triaged case and runs two operator
lanes, each in its own Chromium context with its own goal: one assigns the case to the
on-duty agent, the other to the second on-duty agent, both at the same version. The
harness holds each lane's chosen submit at the declared submit barrier and releases
both together; SC-RACE then requires both requests in flight together (browser request
timing), exactly one accepted, the other refused with a documented lifecycle refusal
(VersionConflict or InvalidSupportCaseTransition; their precedence is undocumented, so
each round records which one it saw), nothing changed by the loser, and only the
winner's assignment, history event and audit record. SC-CHRONOLOGY checks that the
subject case's history never goes back in server-stamped occurrence time, from the
reloaded lists and every case-detail probe. stale-version-denied also carries the
proposed, non-gating SC-REFUSAL-FEEDBACK review: a real Jev model assessment of the
shown refusal against the proposed refusal-feedback-clarity rubric, reported as
inconclusive (blocked in replay) and never counted as a pass. Jev chooses each offered
browser action toward the declared goal; candidate inputs come from prepared fixtures,
captured results, approved text and native samples. Hidden case detail and audit
obligations are read through scoped fixture probes, and every requirement is evaluated
independently.

Exploration requires TYPESAFE_API_KEY. Replay uses captured concrete inputs/actions,
re-resolves fixture and captured identities, and rejects stale builds/specifications
rather than repairing or skipping obligations. --repair-locators first retains a
complete strict replay in <output>-strict-attempt, then replays into <output>, accepting
only changes to the binding's declared presentation files with unchanged binding
semantics and repairing a recorded custom action only onto the single offered action
with the same role, accessible name, attributes, row identity and payload; every repair
is recorded. --fault routes that declared fault's scenario of a replay through its
proxy. Every scenario launches an isolated
actual Support Cases server and a fresh Chromium context. Run 'bun run build' and
'bunx playwright install chromium' first. Evidence is private local JSON +
screenshots/logs, not production-safe data; it is scanned for fixture credentials
and the API key, and any hit fails the run. Nonzero exit: slice not passed,
prerequisites failed, credential found in evidence, or evidence could not be saved.

--faults runs real Jev explorations against labeled defective implementations and
execution controls. Each fault starts its scenario's isolated server behind a scoped
local proxy (no production fault switch): a denied assignment that still assigns, a
resolve followed by deletion of the triaged history row from the isolated SQLite
store, an assignment answered without being written, and a reader's audit read
answered with the administrator's real records; plus racing-target (submit
attributes mutate every 250 ms), deadline (5 s call delay, 15 s deadline) and
desk-wrong-target (support desk row identities rotated on every render) controls.
Hidden-state and direct enforcement probes keep using the owned server.
Each distinct fault scenario also runs once without a proxy as a clean control.
Evidence: <output>/<fault-id>/, <output>/clean/<scenario>/ and <output>/faults.json.
Exit 0 only when every defect fails each affected requirement, no control passes any
requirement and each records its interruption, and every clean control passes. Zero
false acceptance on this finite set is not a universal reliability claim.
All SDA completion entries remain open; this is internally guided functional QA.

Evidence policy support-cases-evidence@1 (local-only): each run claims its output with
.acceptance-owner.json and ends with lineage.json; the owner sees administrator-only
audit-trail results in full, qa and exports only as SHA-256 digests. The run also seals its qa view and
default export bundle against the generated credentials and unrelated audit records.
Inspect, export, or prune with 'bun run acceptance:evidence --help'.
`

const evidence = evidenceLayer(identity)

// No published Support Cases payload codec needs a runtime service because every wire codec is pure.
const codecServices = Context.empty()

const inputs = inputLayer(SupportCasesApplication, codecServices)

const services = Layer.mergeAll(evidence, fixtureLayer, inputs, evaluationLayer)

const command = runAcceptanceCli(definition, services, help)

await Effect.runPromise(command)
