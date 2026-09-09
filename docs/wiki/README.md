# Effect Domains Wiki

This directory is the persistent, source-grounded wiki for the Effect Domains design hypothesis and implementation workspace.

Effect Domains derives routine application machinery from canonical Effect Schemas while leaving semantic storage transformations, business policy, and migration intent explicit. The maintained [framework contract](research-agenda.md#implemented-contract) records the current API; the [validation record](validation-strategy.md#verification-record) separates exercised behavior from historical and unproven claims.

## Content Map

- [Thesis](thesis.md) — central claim, derivation boundary, and architectural principles.
- [Tables and Queries](tables-and-queries.md) — resource authorization, command, persistence, migration, and runtime contracts.
- [Validation Strategy](validation-strategy.md) — slice criteria, dated exercised evidence, and limits.
- [Research Agenda](research-agenda.md) — current implementation contract and unresolved questions.

## Wiki Operations and Sources

- [Wiki instructions](AGENTS.md) — structure, citation rules, review policy, and maintenance workflows.
- [Original project thesis](raw/project-thesis.md) — initial derivation thesis and architectural boundaries.
- [Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md) — human direction for Effect-based implementations and declarative public interfaces.
- [Refactoring and compatibility direction](raw/refactoring-and-compatibility-direction.md) — clean-cutover direction.
- [Domain identifier and basic persistence direction](raw/domain-identifier-and-basic-persistence-direction.md) — domain identity and derived persistence-key direction.
- [Catalog key and table direction](raw/catalog-key-table-direction.md) — superseded catalog interface and earlier table-naming rationale.
- [Derived table creation direction](raw/derived-table-creation-direction.md) — fresh-table derivation and explicit migration direction.
- [Table and query API direction](raw/table-and-query-api-direction.md) — table derivation and authored-query direction.

Files under `raw/` are immutable source material. Maintained pages synthesize them and cite implementation evidence close to claims.

## Current Status

`Resource.make({ name, schema, authorization, storage?, operations, create?, list? })` requires explicit public, deny, or typed policy authorization. Resource policy stays outside canonical schemas; generated repositories enforce scoped SQL visibility and transactional mutation checks. Request-local verified identity reaches protected RPCs through `Authenticator`. Creation defaults/generation, selected CRUD/patch operations, and declared cursor pagination remain mechanical resource capabilities. ([Resource](../../src/resource.ts); [Authorization](../../src/authorization.ts); [RPC authentication](../../src/authorization-rpc.ts))

The checked-in examples now make custom rules runnable: todos combine tenant/owner scope, completion locks, immutable ownership, and admin removal; global shared notes combine reader/editor/admin roles with a service-dependent storage codec. Both use public demo bearer sessions, while basic CRUD and the other four examples remain public. ([Example guide](../../examples/README.md#demo-authentication); [Todo policy](../../examples/resource-crud/resources.ts); [Note policy](../../examples/service-codec/resources.ts))

`Commands.make({ name, group })` retains a native Effect `RpcGroup` and supplies an injectable service descriptor and `.layer` for unary handlers. `Commands.rpc(tag, { payload, success, error })` derives JSON codecs from explicit schemas and returns a native RPC; `Rpc.make` remains the escape hatch. Basic book CRUD needs neither: it selects `Resource.crud`. The separate authored-SQL example retains custom errors and a remove result containing the deleted row. `Application.make({ name, resources, commands })` combines descriptors and generated resources; absent groups use empty arrays. One `ApplicationBun.run` entrypoint exposes remote commands plus `serve`, `schema`, and `inspect`. ([Commands](../../src/commands.ts); [Basic CRUD](../../examples/basic-crud/resources.ts); [Authored SQL](../../examples/authored-sql/contracts.ts); [Runtime](../../src/application-bun.ts))

SQLite history is decoded by the Effectful `SqliteMigrations.decodeHistory(raw)` or loaded from an explicit manifest. Nonempty schemas require an initial migration; one applied-artifact ledger replaces bootstrap/adoption and separate schema-state tracking. `schema generate <name>` validates an artifact before atomically replacing the manifest; blocked plans are not registered. ([Migrations](../../src/sqlite-migrations.ts); [migration regressions](../../test/SqliteMigrations.test.ts))

The earlier simplification removed the generic schema AST algebra, standalone table writes, database alias, framework Query wrapper, and custom command-contract representation. Authorization has its own closed policy AST and fold, not a general schema algebra. Type checking, lint, and all 34 tests across 12 files pass without exclusions. Live checks cover both authorized example CLIs, denied-write preservation, scoped pagination, the unchanged note storage encoding, and historical todo ownership migration/restart. ([Current verification](validation-strategy.md#2026-09-09-authorized-examples); [Earlier authorization verification](validation-strategy.md#2026-09-08-resource-authorization))

## Development

Run these commands from the repository root:

```bash
bun install
bun run check
bun run lint
bun run test
```
