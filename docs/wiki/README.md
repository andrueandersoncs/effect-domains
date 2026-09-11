# Effect Domains Wiki

This directory is the persistent, source-grounded wiki for the Effect Domains design hypothesis and implementation workspace.

Effect Domains derives routine application machinery from canonical Effect Schemas while leaving semantic storage transformations, business policy, and migration intent explicit. The maintained [framework contract](research-agenda.md#implemented-contract) records the current API; the [validation record](validation-strategy.md#verification-record) separates exercised behavior from historical and unproven claims. The implementation is a private Bun workspace: the framework is [`packages/effect-domains`](../../packages/effect-domains/), shared fixtures are [`packages/example-support`](../../packages/example-support/), runnable examples are under [`examples`](../../examples/), and the browser admin is separately prebuilt in [`apps/admin`](../../apps/admin/).

## Content Map

- [Thesis](thesis.md) — central claim, derivation boundary, and architectural principles.
- [Tables and Queries](tables-and-queries.md) — resource authorization, bounded lists, JSON-only CLI input, imported migration artifacts, and native execution composition.
- [Validation Strategy](validation-strategy.md) — slice criteria, completed JSON/history cutover checks, prior validation, and dated evidence limits.
- [Research Agenda](research-agenda.md) — current JSON CLI and decoded-history runtime contract, 2026-09-11 next-slice direction, and remaining evidence.

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

On 2026-09-11 the remaining research questions were sequenced: stay SQLite with more domains; declare joins and query dependencies next; keep explicit per-field storage transforms; prove identity issuance and revocation next; add encoded shapes only when a slice cannot avoid them; defer migration-authoring changes until a history hurts; prove interruption with a failure slice. See [current direction](research-agenda.md#current-direction).

The examples now model concrete applications rather than framework features: reading lists, expenses, team tasks, field notes, editorial calendars, equipment registers, reservations, orders/invoices, report exports, and appointment reminders. See the [application guide](../../examples/README.md) for current contracts and runnable scenarios, and the [domain-example verification](validation-strategy.md#2026-09-10-domain-first-example-applications) for live CLI/MCP, migration, encryption, browser, and durable-restart evidence. Earlier dated verification records describe their original fixtures, even where source links now point to successor applications.

Authorization now supports [declarative entitlement gating](tables-and-queries.md#entitlement-gating) through an application-provided Effect service, with distinct missing-grant and unavailable-resolver errors. Account-level report subscriptions and per-resource purchased guides exercise the same enforcement through native RPCs and generated repositories. Requirements remain separate from row visibility, canonical schemas, and payment processing. [Verification](validation-strategy.md#2026-09-10-entitlement-gating) records 90 passing tests, live entitlement-state changes and restart persistence, account-bound report artifacts, and the limits of those observations.

The [example abstraction pass](validation-strategy.md#2026-09-10-shared-example-abstractions) adds `CalendarDateSchema` and reusable subject-only authorization policies, reuses repositories for expense CRUD and native schemas for billing JSON projections, and centralizes private SQLite and atomic file replacement in example support. Native operation contracts, business transitions, and frozen migration history remain explicit. The user approved retiring only `schema-record-interface`; workspace lint configurations link to the single root rule configuration. Typechecks, remaining lint rules, all 84 tests, and live expense/billing/reminder/report scenarios passed.

The approved [JSON CLI and imported migration-history cutover](validation-strategy.md#2026-09-10-json-cli-and-imported-migration-history) removes generated field flags, manifest files, `SqliteMigrations.load`, and `database.manifest`. Operations accept canonical `--input-json`; native application subcommands, help, and inspection remain. Runtime takes decoded ordered artifact imports through `database: { migrations, filename? }`. The framework is another 799 source lines smaller (15.0%). Final workspace typechecks, unchanged lint rules, all 81 tests, admin and documentation builds, and targeted live CLI/restart/admin HTTP checks passed; the linked record states their limits.

The preceding [2026-09-10 radical simplification](validation-strategy.md#2026-09-10-radical-simplification) supersedes earlier descriptions of inferred migration planning, schema CLI commands, configurable list ordering, the separate repository `page` method, and `ApplicationBun.execution`. The framework is 1,699 source lines smaller (24.2%). Final workspace typechecks, unchanged lint rules, all 68 tests, and the admin build passed. Selected live CLI, MCP, admin HTTP, historical migration, and native worker checks also passed; the linked record states their limits.

`Resource.make({ name, schema, authorization, storage?, relations?, operations })` retains declarative CRUD, optional patch, explicit authorization, creation defaults, generation, and typed subject bindings. Every generated `list` returns bounded `{ items, nextCursor }`, defaults to limit 50, accepts declared equality filters, and orders by identifier ascending only. Table and Authorization now share scalar traversal while retaining distinct storage/canonical interpretations. The creation compiler produces accepted input, value evaluators, and inspection metadata, including implicit UUID generation. Field products and closed operation descriptors feed storage, repositories, and native RPCs without a universal framework or parallel transport DTO. ([Resource](../../packages/effect-domains/src/resource.ts); [Table](../../packages/effect-domains/src/table.ts); [scalar fold](../../packages/effect-domains/src/schema-algebra.ts); [creation compiler](../../packages/effect-domains/src/resource-creation.ts); [current contract](research-agenda.md#implemented-contract))

`Application.make({ name, parts })` composes resources, native RPC bundles, and nested applications. `ApplicationBun.run` retains `services`, `initialize`, `background`, `routes`, and worker-only execution. Native execution layers now compose through application-owned `services` with explicit private SQLite provision. The examples check opened database paths and inodes before native execution tables initialize; the framework no longer supplies a pre-open filename/URL isolation guarantee. ([Application](../../packages/effect-domains/src/application.ts); [Bun runtime](../../packages/effect-domains/src/application-bun.ts); [example isolation](../../packages/example-support/src/databases.ts); [native composition](tables-and-queries.md#native-durable-execution))

`SqliteMigrations.make({ id, from, to, steps })` authors explicit artifacts; `initial({ id, tables })` derives fresh creation. `snapshot` and `decodeHistory` remain; application-owned imports supply ordered artifact JSONs instead of a manifest loader. Existing JSON histories and the applied-artifact ledger retain their format. Runtime still verifies exact managed schema, indexes, foreign keys, immutable ledger contents, and transactional replay. There is no migration planner, generator, intent DSL, or schema CLI. ([Migrations](../../packages/effect-domains/src/sqlite-migrations.ts); [authoring walkthrough](../../examples/README.md#review-schema-changes))

HTTP RPC, MCP, and opt-in prebuilt browser admin remain native adapters over the same operation contracts. Admin and MCP use request-isolated in-process RPC with captured codec services and request-local authentication. Storage codecs remain separate from canonical wire schemas. ([Transport](../../packages/effect-domains/src/rpc-in-process.ts); [admin contract](tables-and-queries.md#commands-applications-and-admin); [stored note codec](../../examples/field-notes/storage.ts))

The [verification record](validation-strategy.md#verification-record) preserves earlier CLI, browser, MCP, migration, billing, and durable-restart observations with their original dates and limits. The [research agenda](research-agenda.md) distinguishes implemented boundaries from broader claims that remain unproven. The [application guide](../../examples/README.md) contains the current walkthroughs.

## Development

Run these commands from the private workspace root. The explicit build precompiles the optional browser admin; runtime only loads its output:

```bash
bun install
bun run build
```

The root checks include all workspace packages and the root integration suite:

```bash
bun run check
bun run lint
bun run test
```
