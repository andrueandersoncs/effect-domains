# Story-driven Acceptance

## Status and Scope

**Core design, implemented. Reduced by the user on 2026-10-11.** After the full design had been built, the user judged it far too complicated for the original request and chose to cut it to the core. This page describes the core that remains. It supersedes the 2026-10-08 full end goal, its twelve-entry completion ledger (SDA-01–SDA-12), and the AP-01–AP-17 implementation plan. Those remain in Git history and in the dated [verification records](validation-strategy.md#verification-record).

The core keeps:

- stories and scenarios bound to compiled operations;
- inputs generated from native Effect Schemas;
- Jev choosing actions in a real browser under harness control;
- plain, application-authored requirement checks;
- saved evidence and model-free replay.

Everything else was deliberately deleted (see [Removed on 2026-10-11](#removed-on-2026-10-11)).

## Sources and Rationale

The originating proposal treats user stories as enduring product truth. It asks whether Jev decision models can drive a browser using stable element identifiers, with validation metadata helping generate inputs. The linked discussions distinguish [story intent from structured acceptance scenarios](https://chatgpt.com/share/6abd0e14-0a68-83ea-aa9c-03311d780dbf) and describe [approved behavioral contracts, reusable product concepts, browser observation contracts, and evidence](https://chatgpt.com/share/6ac7a535-0208-83ea-bd03-95b09575ea59). The core implements the first part of that: stories, scenarios, generated inputs, and browser execution. The product-management concepts from the second discussion are not implemented.

The design fits the [thesis](thesis.md#derivation-boundary). Test inputs are derived from native schemas because that mapping is mechanical. Requirement meaning, fixtures, and evaluators stay authored, because business obligations are not derivable.

[Jev's introduction](https://docs.typesafe.ai/introduction) describes closed-set judgments over supplied state. Its [function-calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling) selects among offered arguments rather than generating arbitrary ones. The [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) name generation, numeric precision, and option-order sensitivity as risks. That is why the harness, not the model, generates values, validates them, and executes actions.

## Design

The tooling lives in the private [`@effect-domains/acceptance`](../../packages/effect-domains-acceptance) package. Each application owns an `acceptance/` directory with its catalog, fixture runtime, and evaluators. The [operating guide](../guides/acceptance.md) documents commands and authoring.

### Catalog

A catalog is encoded data decoded at runtime against the compiled `ApplicationIR`:

```ts
Catalog     { id, actors, requirements, stories, scenarios }
Actor       { id, binding, description }
Requirement { id, text, evaluator }
Story       { id, text, actor, requirements }
Scenario    { id, story, actor, fixture, goal, operations, inputs, required, observations, probes, requirements, reload }
InputCase   { id, operation, description, fields, validity, outcome }
```

Validation rejects duplicate IDs and unresolved references with an actionable message. The checked references are actors and their fixture bindings, evaluators, stories, native operations and payload fields, fixture facts, probes, observation lists, and declared failure tags. It also rejects an input whose declared validity and expected outcome are incoherent, a native strategy the field cannot carry, and a valid literal that the field schema does not decode.

### Inputs

Each payload field names a source:

- `fixture`: a fact from the prepared fixture, with an offset (for example, a stale version);
- `captured`: a field from an earlier accepted result;
- `literal`: a fixed value;
- `native`: a strategy over the operation's native schema (`sample`, `minimum`, `maximum`, `below`, `above`, `fractional`, `null`).

Native samples are drawn for the whole payload, so correlated checks hold. Every candidate is validated against the untouched native contract. An input declares whether it is `native-valid` or `native-invalid`, separately from its expected outcome (`accepted`, `denied` with a declared failure tag, or `rejected`). The harness therefore never "validates away" a deliberately invalid case. Unsupported shapes fail with an explicit limitation instead of approximate values.

### Browser and decisions

The generated Application UI exposes operation, JSON-pointer input, resource, and row-identity attributes. The browser surface turns the rendered state into a bounded set of semantic actions: navigate, enter an exact candidate, submit, observe, reload, or `cannot-proceed`. Jev chooses one action per step from the goal, a compact view, and recent history. The harness owns everything else: it re-checks each choice against a fresh snapshot and refuses stale, disabled, or wrong-target actions. It also enforces the confidence gate (default 0.55), the action budget, and the scenario deadline. Low confidence stops the scenario instead of falling back to a default action. Credentials never reach the model.

### Evaluation

Applications bind each requirement to a named evaluator implemented in Effect. An evaluator receives the scenario, the prepared fixture, the candidates and submissions, before/after observations, hidden-state probes, and direct server-enforcement re-calls. It returns pass, fail, blocked, or inconclusive with an explanation. The navigating model never judges success.

### Evidence and replay

Each run writes `run.json`, a JSON file per scenario, screenshots, and server logs. A run records the build identity (source, UI bundle, catalog, and native-contract hashes) and every model request, distribution, and executed action. The run fails if an API key or fixture secret appears in any retained file. `--replay PATH/run.json` re-executes the recorded actions and values without the model and refuses a replay if any hash differs or scenario coverage is inexact.

## Applications

| Application | What its suite exercises |
| --- | --- |
| [Reading List](../../examples/reading-list/README.md#story-driven-browser-acceptance) | Creation with native samples, null, and omitted rating; rating boundaries; rejected ratings preserve every book |
| [Support Cases](../../examples/support-cases/README.md#story-driven-browser-acceptance) | Lifecycle with history and joined detail; four policy denials; invalid-version rejection; audit access for administrator, reader, and visitor |
| [Expense ledger](../../examples/expense-ledger/README.md) | Sampled records with a pattern-checked currency; codec rejection; handler-side range rejection |
| [Report exports](../../examples/report-exports/README.md) | Sampled nested export requests; reversed-period rejection; reader denial |

## Removed on 2026-10-11

The user decided these are outside scope, and the code was deleted rather than disabled:

- product-management concepts (contexts, needs, capabilities, features, text fixtures), revisions and approval history, catalog imports, and parameterized refinements;
- qualitative rubrics and model assessments;
- concurrent-race and temporal-watch scenarios;
- authored custom-page bindings with locator repair (the Support Cases `/desk` page went with them);
- the live fault-injection proxy, the held-out calibration harness, and runtime verifier controls;
- product queries, the acceptance console, and evidence governance (sealing, lineage, redaction policies, export, retention);
- discoverability runs (goal-only journeys without operation hints) and authenticated custom surfaces.

Every run is internally guided functional QA: scenarios name their operations and inputs. A passing run therefore shows conformance in the exercised cases. It does not show discoverability, usability, or a validated user benefit.

## Evidence

The [verification record](validation-strategy.md#verification-record) holds dated evidence. That includes the [cut-to-core record](validation-strategy.md#2026-10-11-utc-acceptance-cut-to-core) and the earlier records of the full design: feasibility, Slices A and B, and AP-08–AP-17. The earlier records describe code that no longer exists. Their findings that still apply to the applications remain true:

- Support Cases needs a separate identity database per scenario for isolation.
- Transition refusals take precedence over version conflicts.
- report-exports `Poll` reports cause-less durable waits as `Pending`.
