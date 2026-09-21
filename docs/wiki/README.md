# Effect Domains Wiki

This directory is the persistent, source-grounded wiki for the Effect Domains design hypothesis and implementation workspace.

Effect Domains derives routine application machinery from canonical Effect Schemas while leaving semantic storage transformations, business policy, and migration intent explicit. The maintained [framework contract](research-agenda.md#implemented-contract) records the current API; the [validation record](validation-strategy.md#verification-record) separates exercised behavior from historical and unproven claims. The implementation is a private Bun workspace: the framework is [`packages/effect-domains`](../../packages/effect-domains/), the browser interpreter is [`apps/application-ui`](../../apps/application-ui/), shared example infrastructure is [`packages/example-support`](../../packages/example-support/), and runnable applications are under [`examples`](../../examples/).

## Content Map

- [Thesis](thesis.md) — central claim, derivation boundary, and architectural principles.
- [Tables and Queries](tables-and-queries.md) — resource authorization, bounded lists, declared joined projections, imported migrations, and native execution composition.
- [Validation Strategy](validation-strategy.md) — slice criteria, the current [lint-clean compiler record](validation-strategy.md#2026-09-14-better-typescript-lint-completion), native identity/browser/Cluster evidence, synchronization slices, prior validation, and dated evidence limits.
- [Research Agenda](research-agenda.md) — current framework contract, identity boundary, join/dependency slice, and remaining evidence.

## Wiki Operations and Sources

- [Wiki instructions](AGENTS.md) — structure, citation rules, review policy, and maintenance workflows.
- [Original project thesis](raw/project-thesis.md) — initial derivation thesis and architectural boundaries.
- [Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md) — human direction for Effect-based implementations and declarative public interfaces.
- [Refactoring and compatibility direction](raw/refactoring-and-compatibility-direction.md) — clean-cutover direction.
- [Domain identifier and basic persistence direction](raw/domain-identifier-and-basic-persistence-direction.md) — domain identity and derived persistence-key direction.
- [Catalog key and table direction](raw/catalog-key-table-direction.md) — superseded catalog interface and earlier table-naming rationale.
- [Derived table creation direction](raw/derived-table-creation-direction.md) — fresh-table derivation and explicit migration direction.
- [Table and query API direction](raw/table-and-query-api-direction.md) — table derivation and authored-query direction.

Files under `raw/` are immutable source material. Maintained pages synthesize them and cite implementation evidence close to claims. Current implementation links use the workspace layout; dated verification records retain their original dates and observations.

## Current Status

The current explicit compiler architecture cleanly separates intent from derived runtime values. `Resource.define`, `Command.define`, `ReadModel.define`, and `Application.define` produce inspectable syntax; `Resource.compile`, shared folds, and `Application.compile` derive runtime IR. Every adapter now consumes `ApplicationIR`, exact Resource identities survive composition, and the superseded Operation, SqliteView, and implicit application/resource constructors have been deleted. ([Implemented contract](research-agenda.md#implemented-contract); [architecture](tables-and-queries.md); [verification](validation-strategy.md#2026-09-14-explicit-compiler-architecture-cutover))

Feature flags are now explicit application syntax. `FeatureFlags.define` records name/default/description intent, `Part.featureFlag` composes exact declarations through nested applications, `ApplicationIR` and inspection retain the normalized catalog, and the narrow `FeatureFlags` service owns reads and mutations. The supplied memory layer is process-local; durable storage, targeting, rollouts, and administration remain explicit application policy. ([Implemented contract](research-agenda.md#implemented-contract); [runtime reference](../reference/runtime.md#feature-flags); [verification](validation-strategy.md#2026-09-15-declarative-feature-flags))

Infrastructure is now a second explicit compiler boundary after `ApplicationIR`. Provider-neutral resource and binding syntax compiles to an inspectable dependency/capability graph with canonical stable logical IDs, exact writer/backup requirements, and collision-free expanded runtime publications. The same typed `InfrastructureIR` drives in-memory or persistent local Bun execution, real Node artifact/runtime smoke coverage, and process-scoped Railway/Fly plans; unsupported multi-writer and Railway backup schedules, Cloudflare's incompatible transaction model, and local production Alchemy state are rejected before deployment. No cloud stack was applied, so provider credentials, supplied remote state, rollout behavior, and production restore remain unverified. ([Implemented contract](research-agenda.md#implemented-contract); [runtime reference](../reference/runtime.md#infrastructure-and-deployment); [verification](validation-strategy.md#2026-09-16-provider-neutral-infrastructure-and-alchemy-backends))


The current browser cutover makes the generated Application UI an interpreter of `ApplicationIR`. `ApplicationBun.run(..., { ui })` mounts it at `/` by default; inspection drives operation forms, resource lists, declared filters, and cursor paging, while display-only presentation remains external. All thirteen example browser state machines and their Foldkit/RPC support modules have been removed. ([Current contract](../reference/runtime.md#generated-application-ui); [adapter](../../packages/effect-domains/src/application-ui.ts); [verification record](validation-strategy.md#2026-09-15-applicationir-browser-interpreter-cutover))

The earlier 2026-09-14 [native Cluster completion](validation-strategy.md#2026-09-14-native-cluster-completion-and-synchronization-slices) closed the durable integration gaps without a framework workflow/actor DSL. Exact-pinned native layers support local, colocated HTTP runner, and client-only modes behind one example-support boundary; report acceptance uses an application-owned outbox, recoverable suspension, explicit cancellation, immutable artifact reconciliation, and topology guards. Live two-runner verification split shards and completed an approval workflow after owner failure. Field Notes separately proves typed SQL EventLog replica replay/conflict policy while keeping that policy out of canonical Resource metadata. The result is bounded to colocated SQLite processes and one event/projection policy.


The 2026-09-11 [abstraction pass](validation-strategy.md#2026-09-11-abstraction-pass) derived versions, transitions, unique constraints, keyset lists, creation defaults, entitlement resolvers, projections, relation names, scoped foreign keys, identity storage, and compact migration artifacts. Its then-current authored-operation API has since cleanly evolved into `Command.define` plus `Command.implement`; the established business behavior remains.

On 2026-09-11 the remaining research questions were sequenced: stay SQLite with more domains; declare joins and query dependencies; keep explicit per-field storage transforms; implement verified identity issuance and revocation; add encoded shapes only when a slice cannot avoid them; defer migration-authoring changes until a history hurts; and prove interruption with a failure slice. The identity and interruption slices are now complete within their documented bounds; production IdP work and general ambiguous external-commit recovery remain outside the claim. See [current direction](research-agenda.md#current-direction).

The [repair-workshop slice](../../examples/repair-workshop/README.md) supplies the first join/dependency evidence. Its current `ReadModel` declaration derives joined codecs, SQL metadata, a bounded page, and publication from one recursive syntax tree. ([Current contract](tables-and-queries.md#declared-joined-projections); [regression](../../test/ReadModel.test.ts))

The [support-case slice](../../examples/support-cases/README.md) is the second joined-board consumer and the second nested-composition shape. It composes directory and case-management sibling applications whose relations, read model, and commands cross the child boundary; final compilation validates the flattened tree while case/event transactions and nested history SQL remain authored. Its `ui.presentation` supplies custom labels, columns, and descriptions without changing inspection or domain contracts.

Generated Resource lists, `ReadModel.page`, and `RepositoryStore.select` share one private SQLite list kernel. Resource authorization and canonical validation, ReadModel joins/decoding, and store execution remain distinct interpretations.

Automatic [full-stack observability](../reference/runtime.md#opentelemetry) installs project-owned OTLP traces, metrics, and logs across Bun server, CLI, worker, and generated-browser lifetimes. Reading List proves same-origin browser-to-server trace continuity; Report Exports adds worker and business metrics; Support Cases adds nested-application coverage. Safe HTTP/RPC instruments use bounded attributes, runtime-owned spans suppress raw URL/query/header capture, and the browser never receives collector credentials. No endpoint means no project-owned exporter traffic. Report Exports and Support Cases separately persist domain-specific audit records; audit is not inferred from telemetry or generalized into a framework history model. ([Current evidence](validation-strategy.md#2026-09-15-full-stack-observability-and-durable-audit-evidence))

The examples now model concrete applications rather than framework features: reading lists, expenses, team tasks, field notes, editorial calendars, equipment registers, reservations, orders/invoices, report exports, appointment reminders, purchased guides, repair workshops, and support cases. Each `serve` command hosts the generated Application UI at `/` over the same compiled operations used by CLI and MCP. See the [application guide](../../examples/README.md) for current contracts and runnable scenarios; dated verification records retain their original observations and limits.

Protected examples publish native identity operations through the same compiled application. The generated UI calls `identity.login`, keeps the returned bearer token only in memory, applies it per request, and clears it after logout. The separate SQLite credential store issues expiring, revocable opaque credentials while checking current account state, but does not claim production IdP capability.

Authorization supports [declarative entitlement gating](tables-and-queries.md#entitlement-gating) through an application-provided Effect service, with distinct missing-grant and unavailable-resolver errors. Table-backed sources declare typed storage-to-subject `scope` bindings and a closed grant expression built by `Entitlements.for(table)` from typed row fields, `now`, comparisons, and boolean composition. Account-level report subscriptions and per-resource purchased guides exercise status, validity, and cancellation-grace expressions through native RPCs and generated repositories. Requirements remain separate from row visibility, canonical schemas, and payment processing. [Verification](validation-strategy.md#2026-09-10-entitlement-gating) records the earlier behavior boundary; the current contract is linked above.

The [example abstraction pass](validation-strategy.md#2026-09-10-shared-example-abstractions) adds `CalendarDateSchema` and reusable subject-only authorization policies, reuses repositories for expense CRUD and native schemas for billing JSON projections, and centralizes private SQLite and atomic file replacement in example support. Native operation contracts, business transitions, and frozen migration history remain explicit. The user approved retiring only `schema-record-interface`; workspace lint configurations link to the single root rule configuration. Typechecks, remaining lint rules, all 84 tests, and live expense/billing/reminder/report scenarios passed.

The approved [JSON CLI and imported migration-history cutover](validation-strategy.md#2026-09-10-json-cli-and-imported-migration-history) removes generated field flags, manifest files, `SqliteMigrations.load`, and `database.manifest`. Operations accept canonical `--input-json`; native application subcommands, help, and inspection remain. Runtime takes decoded ordered artifact imports through `database: { migrations, filename? }`. The framework is another 799 source lines smaller (15.0%). Final workspace typechecks, unchanged lint rules, all 81 tests, admin and documentation builds, and targeted live CLI/restart/admin HTTP checks passed; the linked record states their limits.

The preceding [2026-09-10 radical simplification](validation-strategy.md#2026-09-10-radical-simplification) supersedes earlier descriptions of inferred migration planning, schema CLI commands, configurable list ordering, the separate repository `page` method, and `ApplicationBun.execution`. The framework is 1,699 source lines smaller (24.2%). Final workspace typechecks, unchanged lint rules, all 68 tests, and the admin build passed. Selected live CLI, MCP, admin HTTP, historical migration, and native worker checks also passed; the linked record states their limits.

`Resource.define` records authorization, capability, creation, list, relation, version, transition, canonical, and storage intent without derived runtime products. `Resource.compile` derives the table, repository, contracts, group, handlers, and exact publication record. Creation input, evaluation, and inspection share one source fold; application composition enforces exact referenced Resource identities.

`Command.define` separates inspectable contract from `Command.implement` behavior. `Command.implement` intentionally remains an authored Effect seam for business decisions, cross-record changes, application SQL, and external interactions; codecs, authorization, transactions, dependency wiring, and unavailable translation derive around it instead of introducing a generic workflow language. `ReadModel.define` and `ReadModel.fold` power joined schema/SQL metadata, dependencies, inspection, paging, and publication. `Application.define` uses explicit Part tags; `Application.compile` produces the sole `ApplicationIR` consumed by runtime, CLI, MCP, Application UI, and inspection.

`SqliteMigrations.make({ id, to, steps })` authors explicit v2 artifacts; `initial({ id, tables })` derives fresh creation; `history(...)` decodes application-owned ordered imports. Runtime still verifies exact managed schema, indexes, foreign keys, immutable ledger contents, and transactional replay. There is no migration planner, generator, intent DSL, or schema CLI. ([Migrations](../../packages/effect-domains/src/sqlite-migrations.ts); [authoring walkthrough](../../examples/README.md#review-schema-changes))

HTTP RPC, MCP, and the prebuilt Application UI remain native adapters over the same operation contracts. UI and MCP use request-isolated in-process RPC with captured codec services and request-local authentication. Storage codecs remain separate from canonical wire schemas. ([Transport](../../packages/effect-domains/src/rpc-in-process.ts); [UI contract](tables-and-queries.md#commands-applications-and-application-ui); [stored note codec](../../examples/field-notes/storage.ts))

The [verification record](validation-strategy.md#verification-record) preserves earlier CLI, browser, MCP, migration, billing, and durable-restart observations with their original dates and limits. The [research agenda](research-agenda.md) distinguishes implemented boundaries from broader claims that remain unproven. The [application guide](../../examples/README.md) contains the current walkthroughs.

Each of the thirteen applications has a standalone README for setup, runnable workflows, observable failures, runtime settings, and source navigation. The [example index](../../examples/README.md) and [documentation catalogue](../examples.md) link to those guides; current browser instructions describe the generated Application UI, while dated verification entries preserve earlier Foldkit observations as historical evidence.

## Development

Run these commands from the private workspace root. The explicit build precompiles the shared Application UI; runtime only loads its output:

```bash
bun install
bun run build
```

`bun run check` runs manifest formatting, workspace and root lint, independent TypeScript checks, the integration suite, and deterministic dependency/boundary checks. Live semantic review uses the API key from `.env`:

```bash
bun run check
bun run lint:semantic
```
