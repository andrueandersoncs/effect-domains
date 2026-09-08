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

`Commands.make({ name, contracts })` creates an injectable service descriptor, RPC group, and `.layer` for handlers. `Application.make({ name, resources, commands })` combines descriptor and resource handlers; empty arrays represent absent groups. `Application.prepare(application)` prepares resource tables. One `ApplicationBun.run` entrypoint exposes generated remote commands plus `serve`, `schema`, and `inspect`; startup prepares the database, builds services, initializes, then launches the server. Runtime options use an `Option` filename, `Layer.empty` for no authored services, and `Effect.void` for no initialization. ([Commands](../../src/commands.ts); [Application](../../src/application.ts); [Bun runtime](../../src/application-bun.ts))

SQLite history is decoded by the Effectful `SqliteMigrations.decodeHistory(raw)` or loaded from an explicit manifest. Nonempty schemas require an initial migration; one applied-artifact ledger replaces bootstrap/adoption and separate schema-state tracking. `schema generate <name>` validates an artifact before atomically replacing the manifest; blocked plans are not registered. ([Migrations](../../src/sqlite-migrations.ts); [migration regressions](../../test/SqliteMigrations.test.ts))

The simplification removes the generic AST algebra, opaque descriptor schema classes, standalone table writes, the database alias, and the framework Query wrapper. Authored SQL uses Effect primitives; native CLI flags remain. Lint remediation now passes lint, type checking, and all 24 tests across nine files without exclusions. Live checks cover generated todo operations and the service-dependent note codec; broader six-application observations remain historical. ([Lint remediation verification](validation-strategy.md#2026-09-08-lint-remediation-verification); [framework contract](research-agenda.md))

## Development

Run these commands from the repository root:

```bash
bun install
bun run check
bun run lint
bun run test
```
