# Effect Domains Wiki

This directory is the persistent, source-grounded wiki for the Effect Domains design hypothesis and implementation workspace.

Effect Domains derives routine application machinery from canonical Effect Schemas while leaving semantic storage transformations, business policy, and migration intent explicit. The maintained [framework contract](research-agenda.md#implemented-contract) records the current API; the [validation record](validation-strategy.md#verification-record) separates exercised behavior from historical and unproven claims. The implementation is now a private Bun workspace: the framework is [`packages/effect-domains`](../../packages/effect-domains/), shared fixtures are [`packages/example-support`](../../packages/example-support/), seven runnable applications are [`apps`](../../apps/), and the browser admin is separately prebuilt in [`apps/admin`](../../apps/admin/).

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

Files under `raw/` are immutable source material. Maintained pages synthesize them and cite implementation evidence close to claims. Current implementation links use the workspace layout; dated verification records retain their original dates and observations.

## Current Status

The [2026-09-09 simplification record](validation-strategy.md#2026-09-09-abstraction-simplification) covers shared check-preserving row derivation, common RPC codec compilation, immutable compiled policies, readonly internal records, and normalized migration source decisions with repeatable intent flags. Package source decreased from 6,927 to 5,946 lines, including the new private RPC compiler. All 45 tests, workspace type checks, the admin build, and targeted runtime/browser scenarios passed; lint remains failing and no rules were disabled.

`Resource.make({ name, schema, authorization, storage?, operations, create?, list? })` requires explicit public, deny, or typed-policy authorization. Under policy authorization, `create.fromSubject` maps canonical target fields to typed `p.subject` operands. Those fields are excluded from the TypeScript and wire create input and a supplied value is rejected before the repository binds the authenticated subject value; defaults, generation, and subject bindings cannot overlap. Resource policy stays outside canonical schemas; generated repositories enforce scoped SQL visibility and transactional mutation checks. ([Resource](../../packages/effect-domains/src/resource.ts); [Authorization](../../packages/effect-domains/src/authorization.ts); [resource contract](tables-and-queries.md#generated-resource-operations))

Storage remains an explicit reversible representation, not a wire contract. For example, the shared-note storage schema changes its `text` field with native `Schema.fieldsAssign`, while resource RPCs retain canonical notes. ([Stored note codec](../../apps/service-codec/storage.ts); [canonical/storage boundary](tables-and-queries.md#canonical-and-storage-representations))

`Commands.make({ name, group })` retains a native Effect `RpcGroup` and supplies an injectable descriptor. Its `.layer(handlers, { catchTags })` maps selected tagged invocation errors, not acquisition failures, defects, or interruption. `Application.make` accepts omitted resource/command groups. `ApplicationBun.run` returns an Effect; `runMain` owns the terminal runtime. Database manifests accept `string | URL`; filename, services, and initialization are optional. ([Commands](../../packages/effect-domains/src/commands.ts); [Application](../../packages/effect-domains/src/application.ts); [Runtime](../../packages/effect-domains/src/application-bun.ts))

`serve` mounts Effect RPC at `/rpc/v1`, derived MCP at `/mcp`, and, only when `admin: true` or an admin options record is selected, the generated browser admin at `/admin` by default. All seven runnable example entrypoints opt in. The [admin build](../../apps/admin/build.ts) precompiles the [browser client](../../apps/admin/src/client.ts) and [stylesheet](../../apps/admin/src/style.css); the [native adapter](../../packages/effect-domains/src/application-admin.ts) only serves those assets.

Admin dispatch uses the same native in-process RPC transport as MCP, preserving handlers, middleware, codecs, and per-call bearer authentication. The client stores no token. Inspection supplies schemas and resource/operation names; optional presentation labels, columns, and descriptions remain display configuration rather than canonical metadata.

SQLite history is decoded by `SqliteMigrations.decodeHistory(raw)` or loaded from an explicit manifest. Nonempty schemas require an initial migration; one applied-artifact ledger replaces bootstrap/adoption and separate schema-state tracking. `schema generate <name>` validates an artifact before atomically replacing the manifest; blocked plans are not registered. ([Migrations](../../packages/effect-domains/src/sqlite-migrations.ts); [migration regressions](../../test/SqliteMigrations.test.ts))

The [workspace verification record](validation-strategy.md#2026-09-09-bun-workspaces-and-prebuilt-admin) records passing builds, all ten workspace type checks, 40 tests, browser CRUD, missing-assets behavior, and an isolated packed-package consumer. The earlier [declarative/admin record](validation-strategy.md#2026-09-09-declarative-inputs-and-generated-admin) retains its broader runtime observations. The known lint failure remains unresolved; no rules were disabled. The [broader evidence boundary](validation-strategy.md#evidence-boundary) remains unchanged.

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
