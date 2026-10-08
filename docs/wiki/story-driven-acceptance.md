# Story-driven Product Specification and Acceptance

## Status and Scope Authority

**Accepted direction; Slice A implemented, full framework open.** On 2026-10-08, the user approved the integration proposal and explicitly required the entire end goal to be documented so that implementation slices cannot replace it. This page is the canonical design and full-completion contract for that direction. The [research agenda](research-agenda.md#story-driven-product-and-acceptance-direction) records its relationship to the wider project; the [Slice A verification record](validation-strategy.md#2026-10-08-reading-list-story-driven-acceptance-slice-a) records implemented behavior and remaining gaps. The earlier [feasibility record](validation-strategy.md#2026-10-08-story-driven-acceptance-feasibility) remains historical evidence.

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

**All twelve entries remain open for full completion.** The application-owned Reading List runner advances the bounded subsets below; neither its passing run nor the earlier feasibility probe closes a full-system entry. Required outcomes and closing gates are unchanged. Updates must retain implementation links, exercised evidence, remaining gaps, and any approved amendment. Do not replace this ledger with a list of finished slices.

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

### Slice A implementation progress — 2026-10-08

The [approved declarative catalog](../../examples/reading-list/acceptance/catalog.ts), [Effect service contracts](../../examples/reading-list/acceptance/model.ts), and [runner](../../examples/reading-list/acceptance/runner.ts) are application-owned. The [dated verification record](validation-strategy.md#2026-10-08-reading-list-story-driven-acceptance-slice-a) identifies the exact build, successful real-Jev run and model-free browser replay, rejected controls, preserved failures, and failed lint check. No scope amendment or gate closure is claimed.

| ID | Exercised Slice A subset | Responsibilities still open |
| --- | --- | --- |
| SDA-01 | Runtime-validated approved/revisioned/provenance-bearing actors, needs, capabilities, requirements, contextual stories, shared obligations, non-goals, open decisions, and scenario/text-fixture references | Materially different domains, reusable parameterized contexts and complete concept vocabulary, and approval/revision workflows |
| SDA-02 | [Bindings](../../examples/reading-list/acceptance/catalog.ts) to real `ApplicationIR` operations/resources, native payload schemas, fixture actors, and named evaluator revisions; missing/incompatible references fail | Ambiguous/imported and obsolete references across composed applications, richer fixture/codec bindings |
| SDA-03 | [Owned fixtures](../../examples/reading-list/acceptance/fixture.ts): fresh SQLite/server/browser context per scenario, real public actor, sentinel/target preparation, scoped shutdown/removal; repeated exploration/replay | Protected ordinary actors, controlled clocks, related preconditions and authorization |
| SDA-04 | [Browser adapter](../../examples/reading-list/acceptance/browser.ts) uses individual generated controls and loaded identity-bearing lists; real guards refuse unknown, altered/wrong-target, and consumed stale actions | Custom-UI binding, related/repeated collection controls, disabled/racing-target coverage |
| SDA-05 | [Real Jev adapter](../../examples/reading-list/acceptance/jev.ts), bounded offered actions, raw probability evidence, confidence guard, action/deadline/no-progress limits; a strict-confidence run stops before execution | Held-out confidence/option-order/model-version calibration and exercised deadline/no-progress cases |
| SDA-06 | [Native generation](../../examples/reading-list/acceptance/inputs.ts) excludes optional forbidden `Never` fields without changing contracts, then uses native encoding/validation; sample/null/omitted/min/max/below/above/fractional strategies and named semantic text fixture | Correlated/contextual/service-dependent/custom-check/recursive shapes beyond the explicitly supported Reading List operations |
| SDA-07 | [Independent evaluators](../../examples/reading-list/acceptance/evaluation.ts) match exact native values and identities after reload, distinguish rejection from no mutation, and separately verify the unrelated fixture; defective and missing-evidence controls | Authorization, history, qualitative review, temporal/sequence/concurrent obligations |
| SDA-08 | [Private local evidence](../../examples/reading-list/acceptance/evidence.ts) records every criterion, exact candidates, hashes/revisions/configuration, browser/model trace, screenshots and failures; missing/stale/subset evidence cannot pass | General production-data redaction/access/retention services, cross-consumer staleness and impact views |
| SDA-09 | Adaptive current-view actions and actual captured-trace replay against fresh applications; only fixture identity is rebound, stale contracts/actions refuse, source failure evidence remains | Semantics-preserving locator repair and recurring regression lifecycle across supported domains; no automatic repair is implemented |
| SDA-10 | Catalog relationships and per-run coverage are serialized for inspection; no product query/view implementation is claimed | Implementation/QA/documentation/change-impact consumer queries and outcome validation |
| SDA-11 | Application-owned narrow Effect services avoid a premature reusable framework | Support Cases, evidence-backed shared extraction, stable general authoring/runtime interfaces and escape hatches |
| SDA-12 | [Operating guide](../../examples/reading-list/README.md#story-driven-browser-acceptance), bounded deliberately defective evaluator controls, false-acceptance/rejection and blocked/inconclusive counts, confidence/stale/overwrite handling | Live injected mutants, history deletion, held-out calibration, general evidence policy and full lint/check acceptance |


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

## Current Evidence and Open Design Decisions

The [2026-10-08 feasibility record](validation-strategy.md#2026-10-08-story-driven-acceptance-feasibility) establishes schema-derived sample acceptance, real-browser input rejection, one generated-input create/reload path, and a direct arbitrary-derivation limitation. It does not exercise a Jev API call, automated story interpretation, independent criterion evaluation, actor isolation, durable evidence storage, regression repair, or the reusable acceptance framework.

The [implemented Slice A record](validation-strategy.md#2026-10-08-reading-list-story-driven-acceptance-slice-a) now establishes real Jev navigation, native operation-aware generation, isolated application/browser execution, independent requirement evaluation, deliberately defective controls, private durable artifacts, and actual replay. This is internally guided functional QA, not discoverability evaluation or proof of a validated reader benefit.

Bounded decisions made for this slice:

- Authoring uses inspectable application-owned Effect Schemas with stable IDs/revisions and approved provenance; scenario input strategies and semantic text sources are declarative. Named authored Effect evaluators own semantics. Do not extract a package before Support Cases supplies evidence.
- Generate from the actual native operation AST. Omit only optional forbidden `Never` properties from the generator; retain native checks and validate/encode every candidate against the untouched operation contract. Apply creation defaults from compiled metadata, not from an invented canonical-input requirement.
- Use mechanically derived operation IDs, JSON-pointer input paths, inclusion controls, resource/row identities, and loaded/unfiltered/complete-list observations. Jev chooses offered actions; one action enters the exact native payload through its individual fields. No whole-payload JSON journey or fixed action script substitutes for browser decisions.
- Use real Jev `jev-1.13.0`, confidence 0.55, 30 actions, a 180-second scenario deadline and 30-second model-call timeout. These settings are uncalibrated; retained uncertainty is an outcome, not a reason to lower the gate.
- Store private local JSON/screenshots/logs, exact source/native/catalog/bundle hashes and revisions, and executed/unexecuted traces. Replay requires matching contracts and preserves recorded failure; stale payloads/targets are not repaired automatically. General retention/redaction and locator repair remain open.


The following decisions remain open without changing the required responsibilities:

- Final authoring syntax, revision/reference representation, package placement, and the extraction boundary after the two slices.
- The smallest inspectable vocabulary for parameterized observations and assertions, with named authored Effect evaluators for semantic cases rather than a general workflow language.
- Operation-aware generation beyond the resolved optional-forbidden-field case: custom checks, recursive/correlated inputs, and captured codec services; supported shapes and explicit unsupported failures.
- Concrete browser binding/collection-path syntax and the boundary between internally guided functional execution and discoverability evaluation.
- Model versions, confidence thresholds, candidate budgets, deadlines, and held-out datasets for calibration; no universal threshold is assumed.
- Evidence persistence format, artifact lifecycle, access/redaction policy, and reproducible replay/regression representation.
- Which concrete scenarios establish temporal, concurrent, and cross-feature obligations beyond the first two slices.

Resolve these decisions in the relevant task, record the choice and evidence here, and retain unmet completion IDs. The obligation to finish the full design is durable even while its implementation details evolve.
