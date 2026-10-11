# Story-driven Product Specification and Acceptance

## Status and Scope Authority

**Accepted direction; implementation plan executed; full system open on two gates.** On 2026-10-08, the user approved the integration proposal and explicitly required the entire end goal to be documented so that implementation slices cannot replace it. This page is the canonical design and full-completion contract for that direction. Work packages AP-01–AP-17 are complete; the [closing-gate review](#closing-gate-review-ap-17-2026-10-11) closes ten ledger entries with evidence and keeps SDA-01 and SDA-07 open pending human approvals and two application decisions. The [research agenda](research-agenda.md#story-driven-product-and-acceptance-direction) records its relationship to the wider project, and the [verification record](validation-strategy.md#verification-record) holds the dated evidence. The earlier feasibility and Slice A records remain historical evidence.

The objective is a declarative product-specification and acceptance-testing layer over `ApplicationIR`: reusable product intent and approved requirements guide implementation and real-browser QA, while Effect Schemas supply authoritative data and operation contracts. The result is requirement-linked execution evidence, not a model-generated success narrative.

**A slice validates part of this design. It does not redefine completion.** Every implementation task must identify which full-completion IDs below it advances, what it does not establish, and where its evidence is recorded. Deferred work remains in the completion ledger. Narrowing the end goal requires an explicit human-approved amendment to this page; a smaller implementation, a passing demonstration, or a closed slice ticket is not such an amendment.

This document specifies responsibilities and observable contracts, not final exported API names. Exact authoring syntax, package ownership, and internal representation remain design questions to resolve through evidence. They must not become a reason to omit any accepted responsibility.

## Sources and Rationale

The originating proposal treats user stories as enduring product truth and asks whether Jev decision models can drive a browser using stable element identifiers, with validation metadata helping generate open-ended inputs. The linked discussions distinguish [story intent from structured acceptance scenarios](https://chatgpt.com/share/6abd0e14-0a68-83ea-aa9c-03311d780dbf) and [approved behavioral contracts, reusable product concepts, browser observation contracts, and evidence](https://chatgpt.com/share/6ac7a535-0208-83ea-bd03-95b09575ea59). This page records the user-approved integration synthesis rather than treating every example policy in those discussions as an Effect Domains requirement.

The proposal fits the existing [thesis](thesis.md#derivation-boundary): test-data generation and equivalent representations are candidates for derivation; business decisions, authorization, transactions, and semantic transformations remain explicit. Final interfaces use inspectable schemas and configuration, with authored Effect implementations behind narrow runtime-provided services. Canonical domain schemas stay free of product-management, browser, and testing concerns.

[Jev's introduction](https://docs.typesafe.ai/introduction) describes Choice, Score, and Noul judgments over supplied state. Its [function-calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling) demonstrates closed-set argument selection, not arbitrary argument generation. The [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) explicitly identify generation, numeric precision, large irrelevant state, adversarial content, and option-order sensitivity as risks. These are dated model-specific constraints, not assumptions that every future model behaves identically.

## Full End Goal

An application author declares product concepts, stories, requirements, scenarios, and explicit bindings to the compiled application. The system validates those declarations, obtains isolated fixtures and ordinary test actors, generates or resolves appropriate inputs, exercises the running application's public interface, evaluates each obligation, and retains evidence tied to the exact specification and build.

The same approved product model is useful to implementation agents, QA agents, documentation generation, and product analysis. It supports asking which needs motivate capabilities, which requirements apply to an operation, which scenarios exercise them, and which builds have current evidence. It does not imply that an approved sentence mechanically generates a correct implementation or proves the intended user benefit.

The desired application-author experience is declarative and automatic where derivation is honest. Authors must not repeatedly rewrite operation schemas, browser validation rules, selectors for generated fields, or mechanically equivalent test data. They still explicitly supply business obligations, semantic fixtures, authorization choices, unusual observations, and domain-specific evaluator implementations when those cannot be derived.

The end goal includes adaptive exploration and repeatable regression execution. Exploration discovers interaction paths; retained replay or regression artifacts exercise approved obligations without requiring a fresh interpretation of their meaning. Repair may change a locator or interaction path, but never silently weaken a requirement or discard the original failure.

## Authority and Derivation Boundaries

| Authority | Owns | Does not establish |
| --- | --- | --- |
| Approved product model | Intent, contextual promises, requirement scope, allowed outcomes, shared obligations | Data codecs, inferred permissions, or implementation algorithms |
| Native Effect Schemas and compiled operation contracts | Types, input/output/error shapes, canonical validation, wire representations | Business success, useful generated content, or existence of referenced records |
| Explicit application policies and implementations | Authorization, transitions, transactions, domain side effects, operational policy | Acceptance merely because the implementation says it succeeded |
| Approved scenario and evaluator bindings | Preparation, observation scope, exact assertions or qualitative rubrics | Exhaustive correctness or proof of a user benefit |
| Captured run evidence | What happened for a particular revision, build, fixture, and execution | Universal correctness or evidence for a later revision |

Do not maintain competing copies of the same schema fact. If an input binding refers to a native rating schema, its valid range is derived from that schema. A separate obligation such as “a rejected rating attempt leaves every book unchanged” is behavioral and must be explicitly specified and independently checked.

A persona is not a permission grant. Context explaining when a need arises is not automatically a software restriction. A capability is intended to address a need, not proven to satisfy it. An invariant is a general obligation; finite examples provide evidence but do not prove it universally. These distinctions preserve the meaning of the source discussions and the existing [authorization boundary](tables-and-queries.md#resource-authorization).

## Declarative Product Model

### Reusable concepts and relationships

Give a concept independent identity when it needs reuse, querying, review, verification, or revision. Otherwise keep it inline; do not turn every noun into a framework entity.

| Concept | Meaning and minimum responsibility |
| --- | --- |
| Role or actor type | Domain perspective or responsibility; resolves to test actors through explicit fixture bindings, not inferred grants |
| Context | Circumstances motivating or constraining a scenario; distinguish narrative context from executable preconditions |
| Need | Problem and desired user outcome, independent of a particular solution |
| Capability | Product action explicitly bound to one or more actual application operations and relevant resources |
| Feature | Product-level grouping of related capabilities, not the existing operational `FeatureFlags` declaration |
| Resource reference | Identifies an existing domain concept or registered Resource; does not redeclare its canonical schema |
| Requirement | Stable obligation, category, applicability, parameters, and observation/evaluation contract |
| Story | Connects actor, context, capability, needs, and scoped requirements; preserves original text and rationale |
| Scenario | Concrete preparation, starting point, goal, input strategy, interaction surface, and requirement references |
| Evidence | Per-requirement results from a particular execution, linked to the specification and evaluator revisions |

Relationships are first-class. One capability can serve several needs; a shared requirement can apply to several operations; one journey can exercise several stories. Do not generate arbitrary combinations of roles and capabilities and call them valid stories. Explicit relationships preserve which promise applies to which actor and situation.

Requirements support behavior, authorization, preservation invariants, and quality obligations. A reusable requirement needs parameter bindings when its target or scope varies: “preserve history” must identify whose history, during which action, and which observations establish preservation. Shared domain, security, platform, and interaction contracts are referenced rather than copied into every story.

Definitions and references retain stable IDs and revisions, provenance, and approval state. Distinguish authored facts, agent-proposed interpretations, and approved obligations. Preserve the original story wording; do not merge identities solely because names or prose match. A delivery ticket can close while its capability and requirements remain active product commitments.

### Declaration validation

Represent public declarations with Effect Schemas and validate imported data at runtime. Resolve references against the complete product catalog and compiled application; reject missing or ambiguous operations, resources, fixture/evaluator bindings, duplicate IDs, incompatible parameters, and unsupported requested interpretations.

Keep three gates distinct:

1. **Structurally valid:** declarations satisfy their schemas.
2. **Contract-ready:** references resolve, required decisions and evaluation bindings exist, and declared cases are coherent within the checkable scope.
3. **Implementation-conformant under exercised conditions:** execution evidence supports the applicable obligations.

A well-typed story can still be vague or contradictory. If a scenario partitions behavior into cases, check gaps and overlaps where the declared vocabulary permits it; do not claim static exhaustiveness for arbitrary authored predicates. Unresolved decisions remain visible and prevent a corresponding completion claim. An implementation agent may propose a contract amendment, but cannot approve its own weakening merely to obtain a passing result.

### Implementation and product consumers

Implementation agents retrieve the relevant approved relationships, native contracts, and shared obligations. They may generate implementation code or propose explicit policy choices; semantic choices still require approval. Acceptance meaning and evaluator interpretation remain independently reviewable rather than owned by the candidate implementation.

Product and documentation consumers can retrieve role-centered journeys, requirement-centered evidence, capabilities without a stated need, requirements without scenarios, and evidence stale against a changed revision. These are queries over declared relationships, not guarantees that all hidden dependencies have been discovered. Implementation status, acceptance evidence, and validated user benefit remain separate statuses.

## Integration with Effect Domains

The existing [application compiler](research-agenda.md#implemented-contract) yields the authoritative `ApplicationIR`; [inspection](../../packages/effect-domains/src/application/inspect.ts) projects unary operation names and input/output/error schemas, creation/list declarations, resource metadata, and explicit policy descriptions. The [generated Application UI](tables-and-queries.md#commands-applications-and-application-ui) already interprets that catalog. These are integration inputs, not evidence that a story system exists.

Bind product declarations to real Resource/Command/native-operation identities at the application composition boundary. Use the compiled operation catalog rather than rediscovering publication or inventing a parallel RPC contract. Resolve serialized references explicitly against that catalog; same-name or ambiguous replacements must not silently select a different target.

Use native schemas for generation, encoding, and authoritative validation. JSON Schema inspection is useful browser-facing metadata, but is not a substitute for service-dependent codecs, arbitrary checks, or other semantics that its representation cannot preserve. Unsupported derivations need an explicit generator/evaluator or a reported unsupported capability, not an approximation advertised as lossless.

Initially keep acceptance tooling application-owned and consume `ApplicationIR`. Do not immediately add `Part.story`, a general workflow DSL, or testing annotations to canonical Resource schemas. After materially different slices, extract the proven common contract into reusable tooling. Application-owned placement is a sequencing choice, not permission to stop at a one-example script.

Implementation uses Effect and narrow runtime-provided interfaces. The following responsibility names are conceptual, not promised exports:

| Boundary | Responsibility |
| --- | --- |
| Product catalog validation | Decode declarations, resolve identities/revisions, validate bindings, and expose inspectable relationships |
| Fixture runtime | Prepare isolated data and ordinary actor sessions, resolve named fixture facts, inspect permitted hidden state, and release owned resources |
| Browser surface | Observe rendered state, enumerate actionable interactions, bind semantic identities, and execute validated browser actions |
| Input candidates | Resolve concrete values and derive or obtain payload candidates using native schemas, context, and declared case strategies |
| Decision model | Evaluate narrow typed questions; the Jev adapter supplies model judgments without controlling execution or acceptance meaning |
| Requirement evaluation | Apply independently identified exact checks or rubric-based assessments to captured observations |
| Run evidence | Retain requirement results, replay inputs, artifacts, revision links, and coverage/staleness information |

Unusual behavior remains an authored Effect seam behind a named binding. Stories compose inspectable references and configuration rather than embedding arbitrary browser procedures or implementation callbacks.

## Browser Interaction Contract

### Prepare, interact, judge

Preparation establishes the real preconditions: isolated application data, known sentinel records, ordinary test accounts, applicable grants, and the intended starting point. Credentials are resolved by the harness, never embedded in stories or sent to a decision model. Browser contexts isolate session state; server-side fixtures also need their own isolation. Cleanup releases only resources owned by the run.

Interaction exercises the declared surface. In a browser acceptance scenario, navigation, editing, and feature submission happen through the actual UI. Privileged fixture setup is permitted, and extra state probes may establish hidden obligations, but a direct API call or database update cannot replace the user-facing action under test.

Judgment evaluates approved requirement IDs against captured evidence. It is separate from choosing the next action. The navigating model cannot declare a pass merely because it sees a success message or believes the journey is complete.

### Action selection and execution

Build a bounded action catalog from currently rendered state. Each option has a stable local ID, meaningful description, action kind, target identity, and any concrete candidate input. For example, options may open a form, enter a proposed title, select a visible related record, submit, reload, or navigate to an observation view.

Send Jev the actor's goal, relevant current state, and a short recent-action history. Ask one narrow question, such as which available action advances this scenario. Do not send an entire raw DOM, unrelated application history, or hidden server privileges. Descriptions convey semantics; an opaque `save-button` identifier alone is not useful decision context. See [Choice](https://docs.typesafe.ai/primitives/choice) and [state guidance](https://docs.typesafe.ai/concepts/state).

The harness owns choice validation, target lookup, visibility/enabled checks, snapshot freshness, actual interaction, waiting for an observable transition, repeated-action detection, and the execution deadline. A choice made against stale state must not execute against a different row or control. Unknown or unavailable choices are not silently repaired into another action.

Offer an explicit cannot-proceed outcome. Low confidence triggers additional observation, a separately permitted escalation, or an inconclusive result; it never defaults to the first option. [TypeSafe confidence](https://docs.typesafe.ai/confidence) is computed from the answer distribution, not proof of correctness. Calibrate risk-sensitive thresholds with held-out scenarios and retain the probabilities and configuration used. Arithmetic, counting, date comparisons, and exact validation stay in code.

Page text and model output are untrusted data. Neither can authorize an action outside the scenario's approved scope. Runs operate on isolated test environments, and destructive actions or external effects require explicit fixture/application policy; model confidence is not authorization. Filter or redact secrets and sensitive content before model requests and evidence retention.

### Semantic bindings, not another schema system

Prefer roles, labels, and accessible names for ordinary interactions. Add stable semantic bindings where identity or ambiguity requires them. Generated forms can derive operation identity and JSON Pointer payload paths:

```html
<form data-operation="books.create">
  <input
    aria-label="title"
    data-input-path="/title"
    data-testid="books.create:title"
  />
  <button data-action="submit">Create book</button>
</form>
```

This is proposed binding syntax, not current generated markup. The harness joins bindings to the operation catalog; it does not infer validation from an element ID. Repeated rows need record identity and operation context, not an array index or position. Nested fields and repeated collection items need unambiguous paths and scope. An authored/custom UI may supply explicit equivalent bindings without changing the domain model.

HTML `min`, `max`, `minlength`, and `pattern` are browser affordances derived only where their semantics match the native contract. A `data-*` attribute enforces nothing. Do not introduce a separately maintained `data-validation-regex` contract or require every open-ended text field to have a regular expression. Server validation and authorization remain authoritative.

### Functional completion versus discoverability

An annotated runner with internal operation hints tests functional completion. A discoverability scenario receives the actor's context and goal without privileged operation identifiers, hidden routes, or implementation hints. It must discover the path from the exposed interface. Keep these modes and their evidence distinct; successful internally guided execution does not prove usability or discoverability.

## Open-ended Input Contract

### Generation, validation, and selection

Generation proposes values; native validation checks admissibility; a decision model selects among candidates when meaning requires judgment. Jev is not responsible for inventing arbitrary strings or reconstructing precise numbers through repeated choices. Exact scenario values are entered directly without a model call.

| Input kind | Candidate strategy |
| --- | --- |
| Enums and booleans | Enumerate values from the native schema; select deterministically or by a narrow semantic judgment |
| Numbers | Schema-derived valid samples plus explicitly requested boundary cases; preserve integer, range, and precision semantics in code |
| Structurally constrained strings | Derived arbitraries, reviewed examples, or explicit custom generators for checks that cannot be generated safely |
| Semantically meaningful text | Approved fixtures or a generative model with a declared purpose, followed by native schema validation |
| Existing identifiers | Resolve fixture identities, visible records, or captured outputs from earlier steps; do not invent a merely well-formed nonexistent ID |
| Dates and times | Resolve explicit scenario/clock context, generate valid representations, and perform calendar/arithmetic checks in code |
| Correlated fields or collections | Generate the whole payload together and preserve declared relations, ordering, and scenario preconditions |

Keep useful semantic examples separate from adversarial or random structural coverage. A generated nonempty string can be valid yet meaningless as a book title or support message. Candidate descriptions should make their relevant distinction clear; if no candidate satisfies the scenario, obtain an explicitly permitted new source or report the limitation rather than choosing an unsuitable value.

### Native schemas, codecs, and creation sources

The installed Effect version provides `Schema.toArbitrary` and `effect/testing/FastCheck`; record the dependency version and generation configuration with evidence. Arbitrary derivation produces decoded values. Encode through the operation's wire codec and supply its declared services when browser input requires an encoded representation; separately bind those values to the actual controls. Do not generate from persistence/storage schemas when the operation expects canonical wire values.

Use creation intent to distinguish caller input from defaults, generated values, and subject-derived fields. Never ask the browser to populate a server-generated identifier or trusted subject field. Do not blindly substitute the canonical Resource schema for every operation payload: create, patch, transition, and authored commands have different input semantics. The existing [creation fold](../../packages/effect-domains/src/resource/creation.ts) is a candidate integration seam, not a commitment to a second schema implementation.

Custom predicates, declaration schemas, recursive structures, rare valid values, and service-dependent transformations may need explicit generation support. Generation must be bounded and report an unsupported or exhausted strategy instead of looping indefinitely. The initial [feasibility observation](validation-strategy.md#2026-10-08-story-driven-acceptance-feasibility) found a forbidden `id`/`Never` field that prevents naive generation of the complete compiled create payload. General operation-aware generation must handle that distinction while preserving the actual input contract.

### Negative cases and replay

Invalid-input scenarios deliberately supply data outside the successful input contract. Declare the violated obligation, expected rejection, and required absence of effects. Do not validate such a candidate away before the browser can submit it. Conversely, valid-path generation is checked before execution so generator defects are not misreported as product defects.

Coverage includes nullable/omitted values, relevant boundaries, Unicode and string semantics, relation existence, and whole-payload constraints where declared. A schema's built-in constraints do not automatically provide scenario coverage or a behavioral oracle. Record concrete candidates, their source, seed/configuration, and chosen values. A generation seed cannot reproduce model decisions; replay requires the actual action and candidate trace.

## Requirements, Observations, and Evidence

### Observation and evaluation

Each requirement identifies what must hold, its applicability and target bindings, and what evidence is sufficient for this scenario. Resolve exact assertions to concrete independently reviewable evaluators. Qualitative evaluation has an explicit rubric and evaluator configuration; model assessments are labeled as such rather than presented as deterministic proof.

Positive effects are not enough. Include preservation obligations, denial behavior, and absence of forbidden side effects. “The record is absent” requires evidence that the intended view loaded, its scope/filter is correct, and a known unrelated record remains present; an empty page or failed request is not a pass. Match records by fixture or captured identity, not similar display text.

Browser journeys establish user-visible behavior. Direct authorization probes check server enforcement independently of hidden buttons. Scoped state comparisons or lower-level invariant tests establish hidden preservation obligations. Reload checks establish behavior across reload; restart durability needs a restart scenario. Eventual completion, deadlines, repeated requests, concurrent actions, and ambiguous outcomes need explicit temporal/sequence contracts when applicable, not an assumption that a single before/after observation covers them.

Approval separates requirement meaning from candidate implementation. Independent agents can still share the same mistaken interpretation, so evaluator semantics and requirement amendments remain reviewable. A schema-valid input and a schema-valid output are not sufficient evidence that the business obligation holds.

### Per-requirement results

| Result | Required meaning |
| --- | --- |
| Pass | The declared evaluation method has sufficient evidence supporting this obligation in the exercised scope |
| Fail | Observed behavior contradicts the approved obligation |
| Blocked | A prerequisite prevented the scenario or criterion from being exercised |
| Inconclusive | Execution or observation occurred, but the available evidence does not justify pass or fail |

Every result records requirement/scenario/evaluator IDs and revisions, evaluation basis (`executable assertion` or `model assessment`), evidence references, and an explanation or limitation. Aggregate reporting preserves missing, stale, blocked, and inconclusive criteria. A successful subset cannot make the full story or full system complete.

The enclosing run records the application build identity, product catalog revision, fixture revision, actor binding without credentials, browser configuration, model identifier/configuration, generation configuration, timestamps, and actual execution trace. Evidence may include before/after observations, screenshots, assertion outputs, relevant redacted network activity, and explicitly scoped state probes. Retention and access policy must avoid exposing credentials or unrelated sensitive records.

Coverage links requirement revisions to scenarios, evaluators, and exercised builds. Changes to requirements, bindings, evaluators, or application contracts identify affected runs and stale evidence. Recorded dependencies provide change-impact candidates, not proof that no unrecorded cross-feature interaction exists. Keep implementation progress, tested conformance, and validated user outcomes distinct.

### Reliability of the verifier itself

Exercise deliberately defective behavior: a success message without a write, a change lost after reload, mutation of an unrelated record, history deletion, denied operations that still mutate, and selection of the wrong target. Include appropriate controls so the verifier cannot pass on missing evidence. Report false acceptance, false rejection, blocked/inconclusive runs, and action completion separately.

Retain reviewed replay or executable regression artifacts for recurring checks, complemented by periodic goal-driven exploration. Locator repair may preserve a requirement; skipping history, accepting an error as success, or weakening an assertion does not. Preserve failure evidence and require approval for semantic changes. Model version and option-order changes require reassessment where they affect the decision task.

## Full-completion Ledger

**Ten entries are closed with evidence; SDA-01 and SDA-07 remain open; full-system completion is not claimed.** The [closing-gate review](#closing-gate-review-ap-17-2026-10-11) below justifies each decision against the final evidence. Required outcomes and closing gates are unchanged. Updates must retain implementation links, exercised evidence, remaining gaps, and any approved amendment. Do not replace this ledger with a list of finished slices.

| ID | Required full-system outcome | Evidence required before closing |
| --- | --- | --- |
| SDA-01 | Declarative, runtime-validated product concepts and contextual stories with revisions, provenance, approval, scoped shared obligations, and non-goals/open decisions | Imported declaration validation and materially different authored stories preserve relationships without duplicate native contracts |
| SDA-02 | Exact bindings to compiled operations/resources, native schemas, fixtures, and evaluator identities | Valid bindings resolve; missing, ambiguous, incompatible, and obsolete references are rejected with actionable failures |
| SDA-03 | Isolated scenario preparation with ordinary actors, controlled clocks/data where needed, and owned-resource cleanup | Repeated runs do not share unintended session/data state; real preconditions and authorization are exercised without model-visible credentials |
| SDA-04 | Browser observation and semantic action execution for generated UI, with an explicit custom-UI binding seam | Real forms, lists, related records, and target identities are exercised; stale, disabled, and wrong-target choices cannot silently execute |
| SDA-05 | Narrow Jev decisions under deterministic harness control, confidence policy, deadlines, and no-progress handling | Real model-backed journeys and held-out decisions demonstrate action selection; uncertainty and unavailable choices retain truthful outcomes |
| SDA-06 | Operation-aware valid and invalid input strategies, including open-ended, nullable, contextual, correlated, and service-dependent shapes where supported | Native validation/encoding and browser entry agree; generated/trusted fields stay excluded; unsupported generators report a limitation rather than fake coverage |
| SDA-07 | Independent requirement evaluation for exact behavior, authorization, preservation, qualitative review, and applicable temporal/sequence obligations | Evaluators reject plausible defective outcomes, use loaded-view/identity controls, and distinguish assertion evidence from model assessment |
| SDA-08 | Durable per-requirement evidence and pass/fail/blocked/inconclusive reporting tied to exact builds and revisions | Missing/stale/subset evidence cannot produce a full pass; artifacts are inspectable, appropriately redacted, and attributable to their actual evaluator |
| SDA-09 | Adaptive exploration plus repeatable replay/regression with semantics-preserving repair | A captured journey can be re-exercised without changing obligations; a repaired locator retains failure history and the original required checks |
| SDA-10 | Product queries and consumer views for implementation, QA, documentation, coverage, and change impact | Consumers use the same approved relationships; gaps and stale evidence are visible; tested behavior is not mislabeled as a validated user benefit |
| SDA-11 | Evidence-backed reusable Effect tooling rather than permanent one-example scripts | At least Reading List and Support Cases exercise materially different shapes through the same documented stable responsibilities, with explicit escape hatches |
| SDA-12 | Verifier reliability and maintained operating contract | Deliberately defective scenarios measure false acceptance and other outcomes; configuration/model limits, authoring, execution, evidence inspection, and failure handling are documented and exercised |

Full completion requires every entry to satisfy its evidence gate, together in the declared supported scope. This does not promise universal correctness, every arbitrary Effect Schema, every UI, or all production domains. Supported capabilities and explicit unsupported outcomes must be honest; deferring a required capability keeps its entry open rather than redefining the scope without approval.

### Closing-gate review (AP-17, 2026-10-11)

Each decision cites current evidence from the [final review record](validation-strategy.md#2026-10-11-utc-full-completion-review-evidence-ap-17) and the package records it links. The supported scope is the shared [`@effect-domains/acceptance`](../../packages/effect-domains-acceptance) package with the Reading List, Support Cases, expense-ledger, and report-exports definitions; the [operating guide](../guides/acceptance.md) is the maintained contract. Closure means the gate's evidence holds in that scope, not universal correctness.

| ID | Decision | Evidence | Limits or missing evidence |
| --- | --- | --- | --- |
| SDA-01 | **Open — needs human approval** | Runtime-decoded catalogs for four materially different applications with actors, contexts, needs, capabilities, features, text fixtures, requirements, stories, scenarios, non-goals, and open decisions; approval states and `id@revision` approval history; revision-pinned imports of a shared platform obligation refined with parameter bindings; actionable rejection of duplicates, unapproved or obsolete declarations, ambiguous or obsolete imports, and interpretations the interpreter cannot apply ([AP-12](validation-strategy.md#2026-10-10-product-model-and-binding-completeness-ap-12), [AP-17](validation-strategy.md#2026-10-11-utc-full-completion-review-evidence-ap-17)) | Every revision created during implementation (catalog revisions, the platform obligation, `SC-RACE@2`, `SC-CHRONOLOGY`, `RE-COMPLETES`, lifecycle requirement revision 2, the desk and race scenarios) is approved only by implementation-recorded history, not by a human; there is no authenticated approval workflow, revision ordering, import of non-requirement concepts, or typed refinement arguments |
| SDA-02 | Closed | Operations, resources, payload fields, declared failure tags (including authorization middleware), list observations, fixture bindings, facts, actors, probes, and evaluator revisions resolve against the compiled `ApplicationIR`; missing, ambiguous (imports), incompatible, and obsolete references are rejected with actionable messages ([AP-05](validation-strategy.md#2026-10-10-support-cases-story-driven-acceptance-slice-b-ap-05ap-07), [AP-12](validation-strategy.md#2026-10-10-product-model-and-binding-completeness-ap-12)) | References resolve against the flattened application, so child-application scoping is not modeled; native references inside imported catalogs are unsupported |
| SDA-03 | Closed | Each scenario owns a fresh server, application, identity, and execution stores, Chromium context, generated credentials, and sessions held only in memory; protected actors (administrator, reader, editor, visitor) and real preconditions are exercised; run-time seals found no credential or unrelated protected record in retained bytes; cleanup leaves no process or directory ([AP-06](validation-strategy.md#2026-10-10-support-cases-story-driven-acceptance-slice-b-ap-05ap-07), [AP-16](validation-strategy.md#2026-10-10-evidence-governance-ap-16)) | No obligation in scope required a controlled clock (ordering uses server timestamps; deadlines are declared) |
| SDA-04 | Closed | Generated forms, lists, nested fieldsets, JSON array entry, related records (joined board/detail probes and the desk's customer/agent rows), and identity-bound targets are exercised; stale (racing), disabled, and wrong-target choices are refused in live controls; authored surfaces are covered by an explicit binding ([AP-08](validation-strategy.md#2026-10-10-live-defective-implementations-and-execution-controls-ap-08), [AP-14](validation-strategy.md#2026-10-10-custom-ui-binding-and-semantics-preserving-locator-repair-ap-14)) | Custom surfaces support public actors only; no visual locators |
| SDA-05 | Closed | Real model-backed journeys in four applications; 252-trial held-out calibration with option-order variation and recorded thresholds and reassessment triggers; confidence stops, `cannot-proceed`, deadline, and action-limit outcomes stay blocked ([AP-09](validation-strategy.md#2026-10-10-held-out-decision-calibration-ap-09), final calibration) | Every available alias resolved to `jev-1.13.0`, so model-version variation could not be exercised |
| SDA-06 | Closed | Declared support matrix: whole-payload native sampling with correlated checks, contextual and correlated sources, nested and array entry, brand/pattern checks, schema-level and handler-side invalid cases, generated-field exclusion, and lossless round trips are run through real browsers; unsupported shapes report limitations ([AP-13](validation-strategy.md#2026-10-10-generation-and-captured-codec-coverage-ap-13)) | Service-dependent wire codecs, recursive payloads, and record generation are package-tested only because no published contract uses them; record browser entry is unsupported |
| SDA-07 | **Open — needs approvals and an application decision** | Independent evaluators for exact behavior, authorization, preservation, history, chronology, a barrier-synchronized version race, and eventual completion reject live defects and constructed controls; model assessments carry a separate basis and never count as passes ([AP-08](validation-strategy.md#2026-10-10-live-defective-implementations-and-execution-controls-ap-08), [AP-15](validation-strategy.md#2026-10-10-temporal-concurrent-and-qualitative-obligations-ap-15)) | Qualitative rubrics are proposed, not approved; the temporal and concurrent requirements are implementation-derived; `RE-COMPLETES` currently fails because report-exports `Poll` reports `Recoverable` during its documented durable wait; the race-refusal precedence is undocumented |
| SDA-08 | Closed | Per-requirement results with requirement, scenario, and evaluator revisions and basis; build identity covering sources, UI bundle, catalogs, imported catalogs, and native contracts; stale and subset evidence cannot pass; governed inspection, redaction, export, retention, and lineage ([AP-11](validation-strategy.md#2026-10-10-product-queries-and-consumers-ap-11), [AP-16](validation-strategy.md#2026-10-10-evidence-governance-ap-16)) | Screenshots are byte-scanned, not OCR-inspected; local-only storage |
| SDA-09 | Closed | Adaptive exploration and model-free replay in every application rebind only fixture and captured identities and refuse stale contracts; `--repair-locators` repaired a real presentation refactor with failure history and every check retained, and refused a wrong-target variant ([AP-14](validation-strategy.md#2026-10-10-custom-ui-binding-and-semantics-preserving-locator-repair-ap-14)) | Repair applies to declared custom-surface locators only; no scheduled regression service |
| SDA-10 | Closed | `bun run acceptance:query` serves requirement, implementation, QA, documentation, gap (including partition coverage), and impact views over the same approved catalogs; stale, missing, partial, and failing evidence is visible; benefit stays "not assessed" or an unresolved model assessment ([AP-11](validation-strategy.md#2026-10-10-product-queries-and-consumers-ap-11)) | Impact uses recorded dependencies only; fault and calibration evidence are not queried |
| SDA-11 | Closed | One package serves four applications with materially different shapes through documented responsibilities; fixtures, evaluators, probes, faults, policies, and surfaces remain explicit application seams ([AP-10](validation-strategy.md#2026-10-10-evidence-backed-shared-extraction-ap-10)) | The package is private to this workspace |
| SDA-12 | Closed | Live defects and execution controls in two applications measure false acceptance (0), false rejection (0), and truthful controls; constructed verifier corpora report zero false verdicts; the [operating guide](../guides/acceptance.md) documents configuration and model limits, authoring, execution, evidence inspection, and failure handling, all exercised in the final runs ([AP-08](validation-strategy.md#2026-10-10-live-defective-implementations-and-execution-controls-ap-08), final faults) | Repository-wide lint and the architecture-lint script fail for reasons outside the acceptance workspaces, which lint clean |

Full-system completion requires SDA-01 and SDA-07. Claimable next work: a human reviews and approves (or amends) the implementation-recorded declarations and the two proposed rubrics; the report-exports maintainer decides whether `Poll` should report normal durable waits as `Pending` or the README should document `Recoverable` differently, after which `RE-COMPLETES` is re-run; and the support-cases maintainer decides whether concurrent stale writes should surface as `VersionConflict` (a framework guard-precedence change) or whether `SC-RACE@2`'s acceptance of either documented refusal is approved.


## Slice Sequence and Anti-narrowing Rules

### Slice A: Reading List

The first slice exercises a reader recording a book and rating through the generated UI. Bind existing [schemas](../../examples/reading-list/domain.ts), [capabilities](../../examples/reading-list/resources.ts), and [application](../../examples/reading-list/application.ts) rather than inventing policies such as requiring a finished status before rating. A reader persona does not add authentication to this currently public application.

Prepare a known unrelated book. Create through the UI, match the created identity and values in a loaded list after reload, exercise relevant rating boundaries including rejection outside 1–5, and confirm rejected attempts preserve both target and sentinel state. Record requirement-linked evidence and include deliberately defective outcomes. Advance only the completion IDs actually demonstrated; naive schema sampling or a successful manual browser submission is not a completed runner.

### Slice B: Support Cases

Use [Support Cases](../../examples/support-cases/README.md) to expose different requirements: related resources, authored commands, joined views, explicit actor/policy bindings, and history preservation. Its [domain behavior](research-agenda.md#application-evidence) already includes guarded transitions, on-duty assignment, and transactional case/event/audit writes. Acceptance requirements must be bound to those existing semantics, not invented from generic CRUD assumptions.

Exercise a real multi-step goal and applicable denial/preservation cases, observing both user-visible results and explicitly scoped hidden obligations. Reuse the same responsibility boundaries as Reading List. Record which contextual input, operation binding, evaluation, and replay responsibilities generalize and which remain explicit application seams.

### Consolidation and remaining coverage

After both slices, extract only the common contract supported by evidence. Continue dedicated work for completion entries not exercised by those domains, such as a custom-UI binding, service-dependent wire generation, temporal/concurrent obligations, consumer queries, or verifier calibration. Passing both initial slices is not sufficient to close the ledger.

Each slice/task record must contain:

- Its referenced SDA IDs and the observable subset it exercises.
- The accepted requirement revisions, concrete fixtures, and application build.
- Implementation and evidence links, including failures and limitations.
- Explicitly unexercised or deferred ledger responsibilities.
- Any proposed scope amendment, kept separate from implementation progress until approved.

Never relabel a hard-coded journey, mocked decision model, incomplete evaluator, JSON-only shortcut, or narrative pass as the full system. A complete-JSON browser control is a legitimate existing UI path, but evidence through it does not establish coverage of individual generated controls. A stub or smoke artifact does not become the final public interface.

## Implementation Plan

**Recorded 2026-10-10. Execution plan under the unchanged accepted scope; not implementation evidence or a scope amendment.** The [full-completion ledger](#full-completion-ledger) remains the closing authority. This section replaces the chat-only next-step recommendation with claimable work packages. Mark a package complete only with its linked code, commands, runtime artifacts, and remaining limitations.

**Package status:** AP-01–AP-04 complete on 2026-10-10 ([checkpoint record](validation-strategy.md#2026-10-10-reading-list-acceptance-lint-cleanup-and-integration-checkpoint-ap-01ap-04)): zero Reading List lint diagnostics, passing types/tests/build, fresh real exploration and model-free replay with 24/24 criteria, and refused stale/reused/keyless/low-confidence runs. AP-05–AP-07 complete on 2026-10-10 ([Slice B record](validation-strategy.md#2026-10-10-support-cases-story-driven-acceptance-slice-b-ap-05ap-07)): native codec/actor probe, typed context sources with independent validity and outcome, `bun run support-cases:acceptance` with real exploration and replay passing 22/22 criteria across lifecycle, four native-valid policy denials, a native-invalid rejection, and administrator/reader/visitor audit bindings. AP-09 complete ([calibration record](validation-strategy.md#2026-10-10-held-out-decision-calibration-ap-09)): blind-reviewed held-out corpus, 252 real trials across option orders and model aliases, thresholds kept with explicit reassessment triggers; model-version variation was unavailable because every alias resolved to `jev-1.13.0`. AP-08 complete ([live fault record](validation-strategy.md#2026-10-10-live-defective-implementations-and-execution-controls-ap-08)): real-model fault runs detect 9/9 live defects with truthful execution controls and passing clean controls. AP-12 complete ([product model record](validation-strategy.md#2026-10-10-product-model-and-binding-completeness-ap-12)): approval history, contexts, features, parameterized refinements, and revision-pinned imports with actionable rejections; both catalogs import the shared platform obligation and pass real runs; remaining unsupported responsibilities are listed there. AP-11 complete ([query record](validation-strategy.md#2026-10-10-product-queries-and-consumers-ap-11)): `bun run acceptance:query` consumers over both catalogs and retained evidence keep implementation status, tested conformance, and user benefit distinct and expose missing, stale, and partial evidence. AP-16 complete ([governance record](validation-strategy.md#2026-10-10-evidence-governance-ap-16)): evidence classes and local-only policies, run-time seal, owner/qa/export access, redacted export with manifest, lineage-preserving retention, and imported-catalog content in replay identity, proven with real authenticated fixtures. AP-13 complete ([generation record](validation-strategy.md#2026-10-10-generation-and-captured-codec-coverage-ap-13)): whole-payload native sampling, runtime codec services, generic round-trip evaluators, expense-ledger and report-exports definitions with real exploration and replay, and a declared support matrix (service-dependent wire codecs, recursion, and records remain package-tested only). AP-14 complete ([custom UI record](validation-strategy.md#2026-10-10-custom-ui-binding-and-semantics-preserving-locator-repair-ap-14)): an authored support desk with related records and repeated rows under an explicit declarative binding, identity-bound row actions, and `--repair-locators` replay that repaired a real presentation refactor without skipping criteria while refusing a wrong-target variant. AP-15 complete ([temporal record](validation-strategy.md#2026-10-10-temporal-concurrent-and-qualitative-obligations-ap-15)): a barrier-synchronized two-context version race (one finding for human review on refusal precedence), explicit chronology and report-exports eventual-completion contracts, and non-gating proposed qualitative model assessments reported as unresolved. AP-10 complete ([extraction record](validation-strategy.md#2026-10-10-evidence-backed-shared-extraction-ap-10)): `@effect-domains/acceptance` package, both applications migrated with real exploration and replay passing, and the non-generalized seams recorded. AP-17 complete ([final review record](validation-strategy.md#2026-10-11-utc-full-completion-review-evidence-ap-17); [closing-gate review](#closing-gate-review-ap-17-2026-10-11)): final runs on one tree, ten gates closed with evidence, SDA-01 and SDA-07 open with named prerequisites. Completing a package closes no SDA entry by itself; only the review does.

Package IDs identify planned outcomes, not a second issue tracker. Use the existing [GitHub work queue](https://github.com/andrueandersoncs/effect-domains/issues/12) for implementation issue ownership/status and link those issues to their packages here. This page owns the dependency/acceptance breakdown and evidence synthesis. This documentation update creates or claims no implementation issue.

### Baseline and constraints

- [Slice A evidence](validation-strategy.md#2026-10-08-reading-list-story-driven-acceptance-slice-a) records nine scenarios, 24 independent results, real Jev/browser execution and model-free replay. Its new acceptance implementation has 2,079 lint diagnostics; that failure is known evidence, not a check to rerun merely to confirm it.
- The [current scenario contract](https://github.com/andrueandersoncs/effect-domains/blob/b68838a/examples/reading-list/acceptance/model.ts) binds one operation and rating-specific strategies. [Generation/replay](https://github.com/andrueandersoncs/effect-domains/blob/b68838a/examples/reading-list/acceptance/inputs.ts) currently equates `expected: accepted/rejected` with native schema validity. That is sufficient for the declared rating cases, but **cannot represent native-valid business-policy denials**. AP-05 must separate structural validity from operation outcome before Support Cases denial scenarios.
- [Support Cases resources](../../examples/support-cases/resources.ts) and its lifecycle commands are public. Assignment requires a real on-duty agent and transitions use an expected version; [the implementations](../../examples/support-cases/sqlite.ts) append event/audit records transactionally. Only [the audit command](../../examples/support-cases/audit.ts) requires the existing admin role. Do not reinterpret an assigned agent as an authenticated subject or add authorization to public commands.
- Final authoring stays declarative. Native contracts, generated/trusted fields, state transitions, and business policies remain authoritative; semantics-changing input sources/assertions stay named application-owned Effect implementations. No hard-coded journey, mocked model, whole-payload JSON shortcut, silent repair, lowered assertion, or lint exclusion counts as completion.
- One acceptance integration owner owns shared contracts and integration. A task's claimant is its implementation/review owner; record the claimant in the linked implementation issue before changing code. Exported changes require references and complete caller migration. Preserve old evidence, remove obsolete code at cutover, and add no compatibility aliases.

### Dependency-ordered work packages

Dependencies are completion prerequisites, not scheduling estimates. AP-02/AP-03 can proceed independently once AP-01 stabilizes the contracts; AP-08/AP-09 and the post-extraction coverage packages are independent where their listed prerequisites allow.

| Package | Depends on | Observable outcome | Gates advanced |
| --- | --- | --- | --- |
| AP-01 | Existing Slice A | Catalog/service-contract lint cleanup with complete caller migration | SDA-01, SDA-02, SDA-12 |
| AP-02 | AP-01 | Native generation and evaluator lint cleanup without changed acceptance semantics | SDA-06, SDA-07, SDA-12 |
| AP-03 | AP-01 | Effect-native browser/model/fixture/evidence boundaries | SDA-03, SDA-04, SDA-05, SDA-08, SDA-12 |
| AP-04 | AP-02, AP-03 | Clean Slice A integration and fresh real exploration/replay | SDA-08, SDA-09, SDA-12 |
| AP-05 | AP-04 | Evidence-backed Support Cases declarations, context sources, and outcome contract | SDA-01, SDA-02, SDA-03, SDA-06 |
| AP-06 | AP-05 | Runnable real-browser Support Cases multi-step goal | SDA-03, SDA-04, SDA-05, SDA-06, SDA-07, SDA-08, SDA-09 |
| AP-07 | AP-06 | Native-valid denials, protected audit access, and history/preservation proof | SDA-02, SDA-03, SDA-07, SDA-08, SDA-09, SDA-12 |
| AP-08 | AP-07 | Live defective implementations and execution-failure controls | SDA-04, SDA-05, SDA-07, SDA-12 |
| AP-09 | AP-06 | Held-out model/option-order/confidence assessment | SDA-05, SDA-12 |
| AP-10 | AP-07 | Shared Effect responsibilities proved by both applications | SDA-11 |
| AP-11 | AP-10 | Product queries and implementation/QA/documentation consumers | SDA-08, SDA-10 |
| AP-12 | AP-10 | Complete supported product relationships, approval/revisions, and binding failures | SDA-01, SDA-02 |
| AP-13 | AP-10 | Declared native generation/codec support matrix | SDA-02, SDA-06 |
| AP-14 | AP-10 | Custom/collection UI binding and semantics-preserving locator repair | SDA-04, SDA-09 |
| AP-15 | AP-10 | Applicable temporal/concurrent and qualitative obligations | SDA-03, SDA-07 |
| AP-16 | AP-07 | Evidence access, redaction, retention, and export contract | SDA-08, SDA-12 |
| AP-17 | AP-08, AP-09, AP-11–AP-16 | Individual full-system closing-gate review | SDA-01–SDA-12 |

### AP-01 — Catalog and service contracts

**Targets:** [model.ts](https://github.com/andrueandersoncs/effect-domains/blob/b68838a/examples/reading-list/acceptance/model.ts), [catalog.ts](../../examples/reading-list/acceptance/catalog.ts), `catalog.test.ts`, and referenced callers needed for an atomic public-contract change.

Use existing Effect schema constructors, Option/error/service conventions and immutable collection patterns. Preserve approved relationships, native references, revisions, scoped requirements and exact serialized candidate values. A lint-driven representation change is not permission to change a story or requirement. Keep the native-valid business-denial extension in AP-05 rather than smuggling it into cleanup.

**Exit evidence:** relevant file diagnostics are resolved; catalog regressions and workspace typechecking pass; invalid/missing bindings still reject. Migrate every caller of any changed exported symbol in this package. Do not replace behavior tests with source-text, forwarding, or incidental-format assertions.

### AP-02 — Native inputs and independent evaluators

**Targets:** [inputs.ts](https://github.com/andrueandersoncs/effect-domains/blob/b68838a/examples/reading-list/acceptance/inputs.ts), [evaluation.ts](../../examples/reading-list/acceptance/evaluation.ts), `inputs.test.ts`, `evaluation.test.ts`.

Refactor against native schemas and existing Effect patterns, retaining optional-forbidden-field exclusion, native validation/encoding, implicit creation defaults, exact identity/reload checks, all-row rejection preservation, and separate sentinel results. No contract weakening or new business rule.

**Exit evidence:** focused input/evaluator tests pass; resolved diagnostics are recorded; the existing labeled verifier controls retain their expected pass/fail/blocked/inconclusive meaning. Exercise any behaviorally changed generation/evaluation path, not just compilation.

### AP-03 — External boundaries

**Targets:** [browser.ts](https://github.com/andrueandersoncs/effect-domains/blob/b68838a/examples/reading-list/acceptance/browser.ts), [jev.ts](https://github.com/andrueandersoncs/effect-domains/blob/b68838a/examples/reading-list/acceptance/jev.ts), [fixture.ts](../../examples/reading-list/acceptance/fixture.ts), [evidence.ts](https://github.com/andrueandersoncs/effect-domains/blob/b68838a/examples/reading-list/acceptance/evidence.ts).

Keep Promise/process/browser interop inside narrow scoped Effect boundaries. Preserve real Jev calls, offered-action validation, exact individual field entry, actual HTTP/reload observations, private artifacts, owned-server/database cleanup, and credential exclusion. Do not trade stricter typing for copied native schemas or fake browser results.

**Exit evidence:** changed real boundary paths are smoked; wrong/unknown/consumed targets refuse; cancellation/failure leaves no owned server or temporary database behind; model responses and executed/unexecuted actions remain attributable. Relevant diagnostics and type errors are resolved.

### AP-04 — Slice A integration checkpoint

**Targets:** [runner.ts](https://github.com/andrueandersoncs/effect-domains/blob/b68838a/examples/reading-list/acceptance/runner.ts), [main.ts](../../examples/reading-list/acceptance/main.ts), both Reading List/root package manifests, the operating guide and verification record.

Finish orchestration/CLI lint cleanup and integrate AP-01–AP-03. Require zero new acceptance-workspace lint diagnostics, passing types/tests, all declared Slice A criteria passing in real exploration and fresh browser replay, and faithful blocked/stale/overwrite outcomes. Do not repeatedly rerun failed model decisions until a convenient pass appears; retain each attempt and diagnose its actual cause. Existing unrelated repository lint issues remain separate.

Run from the repository root, using fresh output directories:

```bash
bun run --filter @effect-domains/example-reading-list lint
bun run typecheck
bun run test
bun run build
bun run reading-list:acceptance --output data/acceptance/ap-04-exploration
TYPESAFE_API_KEY= bun run reading-list:acceptance \
  --replay data/acceptance/ap-04-exploration/run.json \
  --output data/acceptance/ap-04-replay
bun run docs:build
```

**Exit evidence:** link exact new build/catalog/native hashes, model configuration, every criterion, verifier counts, cleanup observations, command exits, and remaining gates. Source changes intentionally make the old build's replay stale; never overwrite or rewrite that evidence. No test-count target or full-repository lint-pass claim substitutes for actual results.

### AP-05 — Support Cases contract/probe checkpoint

**Targets:** planned application-owned `examples/support-cases/acceptance/`; existing [application.ts](../../examples/support-cases/application.ts), [domain.ts](../../examples/support-cases/domain.ts), [contracts.ts](../../examples/support-cases/contracts.ts), [main.ts](../../examples/support-cases/main.ts), [board.ts](../../examples/support-cases/board.ts), [audit.ts](../../examples/support-cases/audit.ts); only the necessary acceptance contract/caller changes.

Run `bun run support-cases inspect` and a disposable native-codec/fixture probe. Record exact bindings for `support.openCase`, `support.advanceCase`, `support.caseDetail`, `support.board`, and `support.auditTrail`. Prove DateTime wire handling and typed contextual sources for customer/agent IDs, captured case identity, and current/stale versions.

Resolve three design questions with that evidence before the wider implementation: a declarative goal with a bounded operation set rather than a fixed action script; named typed context sources rather than model-invented IDs/versions; and **independent native input validity and expected operation outcome**. Prove both native-invalid input and native-valid policy-denied input are representable. Keep assertion semantics application-owned and migrate any changed Reading List callers cleanly.

**Exit evidence:** runtime-validated declarations, actual codec/probe outputs, an explicit supported/unsupported statement, and documented real public/admin actor setup. Verify how credentials are supplied and masked/omitted from screenshots, model inputs, network evidence and logs before authenticated scenarios. Do not add policies to solve harness limitations.

### AP-06 — Support Cases multi-step browser goal

**Targets:** the application-owned catalog, contextual input providers, fixture/browser/evaluator/evidence modules and CLI under `examples/support-cases/acceptance/`, plus package scripts and operating documentation. Preserve the narrow responsibility boundaries already exercised by Reading List; no general framework extraction yet.

Prepare a real customer, on-duty/off-duty agents and unrelated case/history fixtures. Through actual generated controls, open a case, triage, assign an on-duty agent, resolve and reopen it. Jev chooses current offered actions within the approved goal; native schemas and declared context sources supply payloads. Independently assert case identity, versions, assignment/clearing, ordered event history, joined customer/agent values and preservation after reload. Read hidden audit obligations through an explicitly scoped authorized probe, not model narration.

**Required new command:** deliver `bun run support-cases:acceptance` with fresh output and model-free replay options. It is a deliverable of this package, **not an existing command**.

**Exit evidence:** a successful actual multi-step exploration and fresh replay, independent per-requirement results, raw model decisions, native input/output evidence, before/after screenshots and owned-resource cleanup. Reading List remains runnable with its original obligations.

### AP-07 — Denial, audit authorization and history

**Targets:** Support Cases scenario/input/actor bindings and evaluators; the existing native policies in [sqlite.ts](../../examples/support-cases/sqlite.ts) and [audit.ts](../../examples/support-cases/audit.ts) are references, not policies to rewrite.

Exercise native-valid stale-version, off-duty, missing-assignment and disallowed-transition attempts with otherwise appropriate context. Assert the applicable native failure and unchanged case/version, complete event/audit history and unrelated fixtures. Separately exercise the audit command with the real admin binding and denied unauthenticated/non-admin bindings. Do not report a policy denial as a schema failure or claim public lifecycle commands are protected.

**Exit evidence:** successful/denied scenarios and their replays preserve distinct native validity/outcome fields; every criterion has its own result. No credential enters model-visible or retained evidence. Exact history entries/identities remain observable, including hidden obligations; incomplete pages or unavailable probes are inconclusive, not passes.

### AP-08 — Live reliability and failure controls

**Targets:** acceptance-owned fixture/implementation layers and browser/scenario/evaluator controls for both applications. Inject faults only into isolated owned test applications; do not add production fault switches.

Exercise actual success-without-write, lost-after-reload, wrong-target/unrelated mutation, denied-but-mutating operation and history deletion through the real model/browser path. Use real native contracts with explicitly labeled defective implementations, not mocked Jev or fabricated browser observations. Also exercise actual deadline/no-progress and disabled/racing-target outcomes.

**Exit evidence:** clean controls pass, each live defect fails the affected criterion, missing/blocked evidence cannot pass, and counts distinguish false acceptance/rejection from action completion and uncertainty. Retain the mutation/build identity and source/replay failure history. Observed zero false acceptance on this finite corpus is not a universal reliability claim.

### AP-09 — Model calibration checkpoint

**Targets:** a reviewed held-out decision corpus for both applications, the Jev adapter/configuration and calibration evidence; do not reuse the acceptance journeys as the entire calibration set.

Record independently reviewed intended actions/unsafe choices, vary option order and relevant model version, and call real Jev on those held-out states. Measure action selection and confidence against the labels. Report abstention, blocked decisions, unsafe selection and task completion separately.

**Exit evidence:** reproducible corpus/configuration/results and an explicit decision about operating thresholds, budgets and reassessment triggers. Keep the current threshold until evidence justifies a change; semantic acceptance is never delegated to confidence. Human decisions on changed product obligations remain approval checkpoints.

### AP-10 — Evidence-backed shared extraction

**Targets:** the proven common portions of both application-owned runners and their callers. Decide and record package placement/public exports from actual dependencies before moving code; AP-11–AP-15 target those resulting public modules.

Extract only shared catalog/binding validation, orchestration, browser/model service interfaces, evidence and replay responsibilities demonstrated by both applications. Keep policy assertions, actor/fixture sources, hidden-state probes and semantics-changing transforms explicit application seams. Migrate all consumers and remove copied/obsolete implementations; no legacy aliases or generalized workflow DSL.

**Exit evidence:** both applications run through the same documented stable responsibilities, pass real exploration/replay and their negative criteria, and retain escape hatches for the distinct business obligations. Public exports and every consuming workspace declare their dependencies. Record what did **not** generalize.

### AP-11 — Product queries and real consumers

**Targets:** the shared approved catalog/evidence query interface from AP-10, both catalogs/run readers, and actual CLI/documentation/QA consumers.

Implement requirement-to-scenario/evaluator/build coverage, implementation versus tested-conformance views, stale/missing/blocked/inconclusive evidence, and dependency-based change-impact candidates. Keep native contract references and approval/revisions in one source; do not create a second documentation catalog.

**Exit evidence:** actual consumers query both applications, expose untested and stale obligations after controlled revision/build changes, and never label a passing subset as full completion or conformance as validated user benefit. Unrecorded cross-feature effects remain a limitation, not a “no impact” result.

### AP-12 — Product model and binding completeness

**Targets:** AP-10's public declaration/binding schemas, both authored catalogs and imported-catalog validation.

Audit the complete supported concept vocabulary and scoped shared/parameterized obligations against SDA-01. Finish provenance/approval/revision handling. Exercise native operation/resource/fixture/evaluator references across composed applications, including missing, ambiguous, incompatible and obsolete imports.

**Exit evidence:** materially different declarations retain relationships and approval history without copied native contracts; invalid/imported bindings reject with actionable reasons. Record the supported revision/import representation and every remaining unsupported responsibility.

### AP-13 — Generation and captured-codec coverage

**Targets:** AP-10's native binding/input-source interpreter and application-owned providers; select concrete existing codec-dependent application contracts during a documented probe before implementation.

Build a declared support matrix for open-ended, nullable/defaulted, contextual/correlated, recursive/custom-check and service-dependent shapes required by SDA-06. Use exact native validation/encoding and runtime-provided codec services. Unsupported or exhausted generation reports a limitation; it cannot fall back to an unrelated Resource schema or fake coverage.

**Exit evidence:** concrete generated values traverse their actual browser controls and real operations with native decode/encode agreement; valid and isolated invalid cases retain provenance. No generated/trusted field leaks into input. Explicit typed semantic sources remain separate from mechanical sampling.

### AP-14 — UI binding and semantics-preserving repair

**Targets:** AP-10's browser binding seam, generated UI where mechanical metadata is needed, and a concrete custom-UI/related or repeated-collection surface selected by a runnable probe.

Exercise locator/path/identity bindings on the actual supported surfaces, including stale/disabled/racing targets. Add locator repair only when it preserves the original requirement, target and observation scope; changed semantics require approval.

**Exit evidence:** a changed locator can be repaired and replayed without skipping any criterion, while wrong targets or missing required history remain failures/inconclusive. Preserve the original failure, repair provenance, and re-exercised evidence. Custom UI is covered by an explicit binding, not a global selector heuristic.

### AP-15 — Temporal, concurrent and qualitative obligations

**Targets:** application-owned declarations, controlled fixture clock/world where required, scoped observers and the shared result model. Choose concrete applicable requirements from existing domain policy; do not invent business rules to obtain a demonstration.

Exercise an actual concurrent version race and applicable sequence/time obligations with independent state/history observations. For qualitative requirements, separately record an approved review rubric, actual review evidence and `model assessment` versus executable assertion basis; do not relabel deterministic CRUD conformance as user benefit.

**Exit evidence:** deterministic controlled-world observations where needed, complete competing outcomes and preservation, and truthful unresolved/qualitative results. A missing applicable policy or approval is a named prerequisite for that case, not a reason to close SDA-07.

### AP-16 — Evidence governance

**Targets:** both fixture/actor bindings, evidence persistence/readers and operating documentation; preserve AP-05/AP-07 credential protection while implementing the broader contract.

Resolve access, redaction, retention/deletion and export rules for declared evidence classes before exposing protected application data or a remote evidence consumer. Choose conservative local-only handling until those policies exist; this is not permission to omit the full responsibility.

**Exit evidence:** real authenticated synthetic fixtures prove credentials/private unrelated records cannot leak through JSON, screenshots, logs or exports; authorized consumers can inspect permitted evidence; retention/deletion behavior is exercised. Preserve required source/failure/replay lineage without retaining secrets.

### AP-17 — Full-completion review

**Targets:** each SDA-01–SDA-12 ledger row, operating/authoring docs, dependency declarations, current code and verification record.

Evaluate every required full-system outcome and closing gate separately against the supported scope and exact current evidence. Run relevant lint/types/tests/builds and real scenarios; review unresolved generator/UI/actor/temporal/consumer/calibration/governance responsibilities. Neither completed work packages nor two passing slices automatically close a gate.

**Exit evidence:** individually justified closures, or explicit open/blocked entries with missing evidence and claimable next work. Full-system completion requires all gates together; failures, unavailable approval and unsupported required capabilities remain visible. Narrowing accepted scope still requires a human-approved amendment.

## Current Evidence and Open Design Decisions

The [2026-10-08 feasibility record](validation-strategy.md#2026-10-08-story-driven-acceptance-feasibility) and the [Slice A record](validation-strategy.md#2026-10-08-reading-list-story-driven-acceptance-slice-a) remain historical evidence. Current evidence is the 2026-10-10/11 verification sequence from [AP-01–AP-04](validation-strategy.md#2026-10-10-reading-list-acceptance-lint-cleanup-and-integration-checkpoint-ap-01ap-04) through the [final review](validation-strategy.md#2026-10-11-utc-full-completion-review-evidence-ap-17): four applications run internally guided functional QA through one shared package with real Jev decisions and real browsers. None of it evaluates discoverability, and none of it validates a user benefit; qualitative results are unresolved model assessments.

Decisions resolved with that evidence:

- **Authoring and placement.** Catalogs are encoded declarations decoded at runtime against the compiled `ApplicationIR`, owned by each application; the private `@effect-domains/acceptance` package owns validation, input interpretation, browser surfaces, decisions, the runner and CLI, evidence, governance, queries, faults, and calibration. Fixtures, evaluators, probes, faults, policies, and custom-surface bindings stay application seams. References are `ID` or `alias:ID` into revision-pinned imports; approvals are an `id@revision` history.
- **Assertions.** Named authored Effect evaluators own semantics; the package adds generic round-trip evaluators for generation coverage and a rubric-based model-assessment evaluator whose results carry a separate basis and are non-gating. No workflow DSL was introduced.
- **Inputs.** Typed sources (fixture facts, captured results with offsets, approved text, literals, native strategies) with independent native validity and expected outcome; one whole-payload native sample per input case; runtime-provided codec services; unsupported shapes report `inputs.unsupported` or `inputs.exhausted`. The [support matrix](validation-strategy.md#2026-10-10-generation-and-captured-codec-coverage-ap-13) records what is browser-proven, package-tested only, or unsupported.
- **Browser bindings.** Generated UI is bound mechanically through operation, JSON-pointer input, inclusion, resource, and row-identity attributes; authored pages are bound explicitly by a surface declaration pairing presentation locators with semantics. Locator repair re-resolves declared semantics only and retains the strict failure.
- **Model operation.** `jev-1.13.0`, confidence 0.55, per-application action budgets, 180-second deadlines, and 30-second model calls, supported by a blind-reviewed held-out corpus; reassess when the resolved model, instructions, decision-state shape, or corpus changes.
- **Evidence.** Private local JSON, screenshots, and logs with ownership markers, run-time seals, lineage, policy-based redaction, export manifests, and retention; build identity covers sources, UI bundle, catalogs, imported catalogs, and native contracts.
- **Temporal and concurrent scope.** Chronology (Support Cases), a barrier-synchronized version race (Support Cases), and eventual completion (report-exports) are the bound obligations; no controlled clock was required.

Questions that need human direction (they block SDA-01 and SDA-07, not the implemented tooling):

- Approve or amend the implementation-recorded declaration revisions and the platform obligation, and approve or revise the proposed qualitative rubrics `refusal-feedback-clarity@1` and `rating-rejection-clarity@1`.
- Report-exports: `Poll` reports `Recoverable` during the workflow's documented durable five-second wait, contradicting the README's description of `Recoverable` as an infrastructure failure; decide whether to change `Poll` or the documentation.
- Support Cases: a same-version concurrent loser is refused with `InvalidSupportCaseTransition` because transition guards run before the version-guarded update; decide whether that precedence is intended or whether concurrent stale writes should surface as `VersionConflict`.
- Whether discoverability evaluation (goal-only runs without operation hints) and authenticated custom surfaces should become supported-scope requirements.
