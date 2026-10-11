# Run story-driven acceptance

Use this guide to declare product stories for an application, exercise them in a real browser with model-chosen actions, and inspect the retained evidence. The shared tooling is the private workspace [`@effect-domains/acceptance`](https://github.com/andrueandersoncs/effect-domains/tree/main/packages/effect-domains-acceptance); Reading List, Support Cases, expense-ledger, and report-exports consume it. The full design and its open completion ledger are in the [story-driven acceptance wiki page](../wiki/story-driven-acceptance.md); a passing run is evidence for its declared scope only.

## Prerequisites

From the repository root:

```bash
bun install
bun run build
(cd packages/effect-domains-acceptance && bunx playwright install chromium)
```

Exploration calls the real Jev model and requires `TYPESAFE_API_KEY` in the environment or the untracked root `.env`. There is no mock model: without a key, exploration refuses to start. Replay never calls the model.

## Run an application's acceptance suite

```bash
bun run reading-list:acceptance --output data/acceptance/reading-list-review
bun run support-cases:acceptance --output data/acceptance/support-cases-review
TYPESAFE_API_KEY= bun run support-cases:acceptance \
  --replay data/acceptance/support-cases-review/run.json \
  --output data/acceptance/support-cases-replay
bun run support-cases:acceptance --help
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--output DIR` | timestamped under `data/acceptance/` | Fresh evidence directory; an existing run is never overwritten |
| `--seed N` | `42` | Seed for native samples; recorded with every candidate |
| `--model ID` | `jev-1.13.0` | Decision model; the resolved model is recorded per decision |
| `--minimum-confidence P` | `0.55` | Below this, the chosen action is not executed and the scenario is blocked |
| `--max-actions N` | per application (30 or 40) | No-progress budget per scenario |
| `--deadline-seconds S` | `180` | Scenario deadline |
| `--replay run.json` | none | Re-exercise a captured trace without the model |
| `--faults` | off | Run the application's declared live defects and execution controls |
| `--fault ID` | none | Run one declared fault (for example with a replay) |
| `--repair-locators` | off | With `--replay`, retain a strict replay and then repair custom-surface locators by declared semantics only |

Each scenario starts the real application on a fresh loopback port with owned temporary databases (including the identity database), seeds fixture data through public operations, opens a fresh Chromium context, and releases everything afterwards. Exit `0` means every approved requirement of every scenario passed and the constructed verifier controls behaved as expected; anything blocked, inconclusive, failing, stale, or leaking exits `1`.

## Author an application definition

An application keeps four owned pieces under `examples/<app>/acceptance/` and exposes `./acceptance/definition` from its manifest:

1. **Catalog** (`catalog.ts`): the encoded, runtime-decoded declaration. It names actors (each bound to a fixture actor such as a public operator or an administrator session), reusable contexts (narrative plus executable fixture preconditions), needs, capabilities bound to compiled operations and resources, features grouping capabilities, approved text fixtures, requirements (with optional parameters and `refines` links to shared obligations imported with `alias:ID`), stories, and scenarios. A scenario declares a goal, a bounded operation set, input cases whose fields come from typed sources—`fixture` facts, `captured` result fields (with integer offsets for stale versions), approved `text`, `literal` values, or `native` strategies (`sample`, `minimum`, `maximum`, `below`, `above`, `fractional`, `null`)—each input's **native validity** and **expected outcome** (`accepted`, a native denial `_tag`, or `rejected`), the inputs required for completion, the resources observed before and after, declared probes, and requirements. Approval states are `authored`, `proposed`, or `approved`, with an approval history naming exact `id@revision` entries; only approved declarations run. A scenario may also declare non-gating `assessments`: qualitative requirements with a rubric, judged by a real model assessment whose result carries the basis `model assessment`, is reported as unresolved while the rubric is not approved, and never counts toward a pass. Concurrency scenarios declare multiple browser lanes and a submission barrier that the harness releases together; temporal obligations declare watches (a probe, interval, and deadline) whose expiry is inconclusive, never a pass.
2. **Fixture** (`fixture.ts`): a `FixtureRuntime` composed from the package `serve`/`call` helpers—owned process and stores, seeded data, facts, actor sessions held only in memory, explicitly scoped probes of hidden state, and direct server-enforcement calls.
3. **Evaluators** (`evaluation.ts`): independent executable assertions per requirement that decode results with native schemas and report `pass`, `fail`, `blocked`, or `inconclusive`, plus a constructed verifier corpus of clean, defective, and missing-evidence controls. Generation-matrix applications can use the package's generic round-trip evaluators.
4. **Definition** (`definition.ts`): the catalog registry, compiled application, evaluator revisions, verifier, observation and probe rules, live fault declarations, evidence policy, and any custom-UI surface bindings, wired into `main.ts` through `runAcceptanceCli`.

Authored pages are bound explicitly, never by a global selector heuristic. A `SurfaceDeclaration` names the page path, ready selector, source operation, the repeated row locator with its identity attribute and column bindings, and each row action's trigger, controls, field sources (row identity, column, literal, control), and settle selector. Every element pairs a presentation locator with semantics (ARIA role, exact accessible name, application `data-*` attributes). Row actions are bound to the row's identity, never its position, and execute only when the composed request equals the declared candidate.

Validation fails with actionable messages for unknown operations, resources, payload fields, fixture facts, actors, probes, failure tags the operation does not declare, incoherent validity/outcome pairs, missing or obsolete approvals and imports, ambiguous references, and unbound refinement parameters. Native-strategy and validity mismatches are reported at resolution time as generator or declaration defects, never as product failures.

## What the model does and does not do

Jev receives the goal, a bounded rendered view (rows, current form, completed submissions, remaining inputs with their declared expected responses) and the currently offered actions; it never sees credentials or hidden probes. It chooses navigation, exact candidate entry, submission, observation, reload, or `cannot-proceed`. The harness validates every choice against a fresh snapshot, refuses stale, altered, consumed, wrong-target, hidden, or disabled targets, enforces the confidence gate, budget, deadline, and repeated-action guard, and records every decision with its probabilities. Acceptance is decided only by the evaluators. The [held-out calibration](../wiki/validation-strategy.md#2026-10-10-held-out-decision-calibration-ap-09) supports the default gate on its finite corpus; re-run `bun run acceptance:calibrate --corpora … --models … --output DIR` when the resolved model, adapter instructions, or decision-state shape change.

## Inspect and govern evidence

Each run writes `run.json`, per-scenario JSON, verifier results, screenshots, and server logs, together with an ownership marker and, after sealing, `lineage.json`. Runs fail if any secret or unrelated protected record appears in retained bytes.

```bash
bun run acceptance:query qa --application all
bun run acceptance:query requirements --application support-cases --json
bun run acceptance:query impact --changed support.advanceCase
bun run acceptance:evidence inspect data/acceptance/support-cases-review --as qa
bun run acceptance:evidence export data/acceptance/support-cases-review --output data/acceptance/support-cases-export
bun run acceptance:evidence prune data/acceptance --now 2026-12-01
```

Queries keep implementation status, tested conformance on the current build, and validated user benefit separate; results from another build, catalog revision, requirement revision, or evaluator revision are stale. Impact output lists candidates from recorded dependencies only. The evidence policy grants owners raw access, gives `qa` redacted reports and digests of protected results, exports only redacted JSON with a manifest (screenshots and logs excluded unless requested), and prunes expired artifacts of owned, sealed runs only when `--apply` is given, keeping lineage.

## Exercise the verifier

`--faults` runs each declared live defect through an acceptance-owned proxy in front of an isolated application (success without write, lost-after-reload, wrong target, denied-but-mutating, history deletion, audit leak) and each execution control (deadline, action limit, racing or disabled target), plus clean controls, and writes `faults.json`. Every defect must fail its affected requirements, every control must end without a passing criterion, and every clean control must pass. No application contains a fault switch.

## Failure handling

- **Blocked**: a prerequisite prevented exercise (low confidence, `cannot-proceed`, deadline, budget, refused target, fixture failure). Read the scenario's `interruption` and trace; do not lower the gate to obtain a pass.
- **Inconclusive**: evidence was insufficient (unloaded or filtered view, missing reload, failed probe). Fix the observation or fixture, then run again into a fresh directory.
- **Fail**: observed behavior contradicts an approved obligation. Retain the run; a fix must be re-verified by a new run.
- **Stale replay**: application, catalog (including imported catalogs), evaluator, binding, or native contracts changed. Run a new exploration; replays never repair semantics. When only declared presentation files of a custom surface changed, `--replay … --repair-locators` keeps the failed strict attempt and may re-resolve each recorded action to exactly one element with the same role, accessible name, attributes, row identity, and payload; anything else stays a failure.
- Keep failing and superseded directories. Record runs used as evidence in the [verification record](../wiki/validation-strategy.md).
