# Effect Domains Wiki

This directory is the persistent, source-grounded wiki for the Effect Domains design hypothesis and implementation workspace.

Effect Domains derives routine application machinery from canonical Effect Schemas while leaving semantic storage transformations, business policy, and migration intent explicit. The maintained [framework contract](research-agenda.md#implemented-contract) records the current API; the [validation record](validation-strategy.md#verification-record) separates exercised behavior from historical and unproven claims.

## Content Map

- [Thesis](thesis.md) — central claim, derivation boundary, and architectural principles.
- [Tables and Queries](tables-and-queries.md) — resource, command, persistence, migration, and runtime contracts.
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

`Resource.make({ name, schema, storage?, operations, create?, list? })` keeps canonical and reversible storage schemas distinct, derives selected CRUD/patch RPCs, and can apply absent-only defaults or runtime `uuidV7`/`now` values. Declared list policy supplies exact filters, stable ordering, bounded pages, and cursors; patch requests are `{ identifier, patch }` and cannot change the identifier. ([Resource](../../src/resource.ts); [resource regressions](../../test/ResourceCrud.test.ts))

`Commands.make(name, contracts)` creates an injectable service descriptor, RPC group, and `.layer` for handlers. `Application.make({ name, resources?, commands? })` combines descriptor and resource handlers. One `ApplicationBun.run` entrypoint exposes generated remote commands plus `serve`, `schema`, and `inspect`; startup prepares the database, builds services, runs optional initialization, then launches the server. ([Commands](../../src/commands.ts); [Application](../../src/application.ts); [Bun runtime](../../src/application-bun.ts))

SQLite migration history is either decoded with `SqliteMigrations.history(raw)` or loaded from an explicit manifest. `schema generate <name>` writes a validated artifact before atomically replacing that manifest, and reports blocked plans without registering them. `inspect` documents resource schemas, creation/list policy, storage representation, and generated operation schemas. ([Migrations](../../src/sqlite-migrations.ts); [inspection](../../src/application-inspect.ts); [migration regressions](../../test/SqliteMigrations.test.ts))

The current verification entry records six exercised applications, 33 passing tests across 11 files, and a passing type check; it does not establish another database adapter or materially different business-policy slice. Lint is not clean: its final run reported 772 diagnostics across 30 files. ([Verification record](validation-strategy.md#2026-09-08-current-verification))

## Development

Run these commands from the repository root:

```bash
bun install
bun run check
bun run lint
bun run test
```
