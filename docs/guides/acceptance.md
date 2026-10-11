# Run story-driven acceptance

Use this guide to declare stories for an application and run them in a real browser. A real Jev model chooses each action, the inputs come from your native schemas, and your own checks decide pass or fail. The shared tooling is the private workspace [`@effect-domains/acceptance`](https://github.com/andrueandersoncs/effect-domains/tree/main/packages/effect-domains-acceptance). Reading List, Support Cases, expense-ledger, and report-exports use it. The design is described on the [story-driven acceptance wiki page](../wiki/story-driven-acceptance.md).

## Prerequisites

From the repository root:

```bash
bun install
bun run build
(cd packages/effect-domains-acceptance && bunx playwright install chromium)
```

Exploration calls the real Jev model and needs `TYPESAFE_API_KEY`, set either in the environment or in the untracked root `.env`. There is no mock model, so exploration refuses to start without a key. Replay never calls the model.

## Run a suite

```bash
bun run support-cases:acceptance --output data/acceptance/support-cases-review
TYPESAFE_API_KEY= bun run support-cases:acceptance \
  --replay data/acceptance/support-cases-review/run.json \
  --output data/acceptance/support-cases-replay
bun run support-cases:acceptance --help
```

The same options work for `reading-list:acceptance`, `expense-ledger:acceptance`, and `report-exports:acceptance`.

| Option | Default | Meaning |
| --- | --- | --- |
| `--output DIR` | timestamped under `data/acceptance/` | Fresh evidence directory; an existing run is never overwritten |
| `--seed N` | `42` | Seed for native samples |
| `--model ID` | `jev-1.13.0` | Decision model |
| `--minimum-confidence P` | `0.55` | Below this, the chosen action is not executed and the scenario stops |
| `--max-actions N` | per application | Action budget per scenario |
| `--deadline-seconds S` | `180` | Scenario deadline |
| `--replay run.json` | none | Re-run a recorded trace without the model |

For each scenario, the harness:

1. starts the real application on a fresh loopback port with its own temporary databases;
2. seeds fixture data through public operations;
3. opens a fresh Chromium context;
4. releases everything afterwards.

Exit `0` means every requirement of every scenario passed. Exit `1` means something was blocked, inconclusive, failing, or stale, or a secret leaked into the evidence.

## Author a suite

An application keeps three pieces under `examples/<app>/acceptance/`, wired together in `main.ts` with `runAcceptanceCli`.

### Catalog (`catalog.ts`)

```ts
export const catalog: typeof Catalog.Encoded = {
  id: "reading-list",
  actors: [{ id: "reader", binding: "public", description: "A person keeping a reading list." }],
  requirements: [{ id: "RL-CREATE", text: "A created book appears with its values.", evaluator: "created-values" }],
  stories: [{ id: "record-reading", text: "As a reader, I want to record a book…", actor: "reader", requirements: ["RL-CREATE"] }],
  scenarios: [{
    id: "create-sample", story: "record-reading", actor: "reader", fixture: "isolated-reading-list",
    goal: "Record the proposed book, then reload and verify it in the Books list.",
    operations: ["books.create"], observations: ["books"], probes: [], requirements: ["RL-CREATE"], reload: true,
    required: ["create"],
    inputs: [{
      id: "create", operation: "books.create", description: "A sampled valid book",
      fields: { title: { source: "literal", value: "The Dispossessed" }, rating: { source: "native", strategy: "sample" } },
      validity: "native-valid", outcome: { kind: "accepted" },
    }],
  }],
}
```

A field's value comes from one of four sources:

| Source | Value |
| --- | --- |
| `fixture` | A fact from the prepared fixture, with an `offset` (for example, a stale version) |
| `captured` | A field from an earlier accepted result |
| `literal` | A fixed value |
| `native` | A strategy over the operation's native schema: `sample`, `minimum`, `maximum`, `below`, `above`, `fractional`, or `null` |

`validity` (`native-valid` or `native-invalid`) and `outcome` (`accepted`, `denied` with a declared failure tag, or `rejected`) are declared separately. An invalid case therefore reaches the server instead of being filtered out.

The catalog is validated at startup against the compiled application. Unknown operations, payload fields, fixture facts, actors, probes, evaluators, or undeclared failure tags fail with a message naming the problem. So do duplicate IDs, incoherent validity/outcome pairs, and native strategies a field cannot carry.

### Fixture (`fixture.ts`)

A `FixtureRuntime` built from the package's `serve` and `call` helpers. It provides:

- the owned application process and stores;
- seeded data and named facts;
- actor sessions, held only in memory;
- probes of hidden state;
- direct server calls that check enforcement independently of the UI.

### Evaluators (`evaluation.ts`)

A `RequirementEvaluation` service implements one Effect check per evaluator name. It reads the evaluation context, decodes results with the native schemas, and returns `pass`, `fail`, `blocked`, or `inconclusive` with an explanation. The context holds the candidates, submissions, before/after observations, probes, and direct re-calls.

## What the model does

Jev receives the goal, a compact view of the page, its recent actions, and the currently offered actions. It never sees credentials or probe results. Each step, it chooses one action: navigate, enter an exact candidate, submit, observe, reload, or `cannot-proceed`.

The harness checks every choice against a fresh snapshot and refuses stale, disabled, or wrong-target actions. It also enforces the confidence gate, the budget, and the deadline, and records every decision with its probabilities. Only the evaluators decide acceptance.

Runs are guided by the scenario's declared operations and inputs. A passing run shows the behavior works. It does not show that a user could find the path unaided.

## Evidence

Each run writes `run.json`, a `scenario.json` and screenshots per scenario, and server logs. `run.json` records the build identity (source, UI bundle, catalog, and native-contract hashes), the configuration, and every decision. The run fails if the API key or a fixture secret appears in any retained file. Replay refuses to run against a different build, catalog, or native contract.

## Failure handling

- **Blocked:** a prerequisite prevented the scenario. Examples: low confidence, `cannot-proceed`, deadline, budget, a refused target, a fixture failure. Read the scenario's `interruption` and trace. Do not lower the gate to obtain a pass.
- **Inconclusive:** evidence was insufficient, for example an unloaded or filtered view, or a failed probe. Fix the observation or fixture and run again into a fresh directory.
- **Fail:** observed behavior contradicts the requirement. Keep the run, fix the application, and verify the fix with a new run.
- **Stale replay:** the application, catalog, or native contracts changed. Run a new exploration.
