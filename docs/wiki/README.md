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

`Resource.make({ name, schema, authorization, storage?, operations, create?, list? })` requires explicit public, deny, or typed-policy authorization. Under policy authorization, `create.fromSubject` maps canonical target fields to typed `p.subject` operands. Those fields are excluded from the TypeScript and wire create input and a supplied value is rejected before the repository binds the authenticated subject value; defaults, generation, and subject bindings cannot overlap. Resource policy stays outside canonical schemas; generated repositories enforce scoped SQL visibility and transactional mutation checks. ([Resource](../../src/resource.ts); [Authorization](../../src/authorization.ts); [resource contract](tables-and-queries.md#generated-resource-operations))

Storage remains an explicit reversible representation, not a wire contract. For example, the shared-note storage schema changes its `text` field with native `Schema.fieldsAssign`, while resource RPCs retain canonical notes. ([Stored note codec](../../examples/service-codec/storage.ts); [canonical/storage boundary](tables-and-queries.md#canonical-and-storage-representations))

`Commands.make({ name, group })` retains a native Effect `RpcGroup` and supplies an injectable descriptor. Its `.layer(handlers, { catchTags })` maps selected tagged invocation errors, not acquisition failures, defects, or interruption. `Application.make` accepts omitted resource/command groups. `ApplicationBun.run` returns an Effect; `runMain` owns the terminal runtime. Database manifests accept `string | URL`; filename, services, and initialization are optional. ([Commands](../../src/commands.ts); [Application](../../src/application.ts); [Runtime](../../src/application-bun.ts))

`serve` mounts Effect RPC at `/rpc/v1`, derived MCP at `/mcp`, and, only when `admin: true` or an admin options record is selected, the generated browser admin at `/admin` by default. All seven runnable example entrypoints opt in. The admin calls the same native in-process RPC transport used by MCP, so handlers, middleware, codecs, and request bearer authentication remain authoritative on every call; it stores no token. Inspection supplies schemas and resource/operation names, while optional presentation labels, columns, and descriptions are display configuration rather than canonical metadata. The client generates forms, list filters, cursor pages, and a JSON-input fallback. Browser calls require same-origin and are trusted by default only on loopback; a non-loopback host requires explicit `allowedOrigins`, which is not a general CORS grant. ([Bun runtime](../../src/application-bun.ts); [Admin adapter](../../src/application-admin.ts); [Admin client](../../src/admin-client.ts); [MCP adapter](../../src/rpc-mcp.ts); [example entrypoints](../../examples/))

SQLite history is decoded by `SqliteMigrations.decodeHistory(raw)` or loaded from an explicit manifest. Nonempty schemas require an initial migration; one applied-artifact ledger replaces bootstrap/adoption and separate schema-state tracking. `schema generate <name>` validates an artifact before atomically replacing the manifest; blocked plans are not registered. ([Migrations](../../src/sqlite-migrations.ts); [migration regressions](../../test/SqliteMigrations.test.ts))

The [declarative/admin verification record](validation-strategy.md#2026-09-09-declarative-inputs-and-generated-admin) records passing type checks and 40 tests, plus live browser, CLI, MCP, storage, and runtime-default checks. Lint still reports source-style and boundary rules; no rules were disabled. Earlier dated authorization/MCP records remain historical evidence. The [broader evidence boundary](validation-strategy.md#evidence-boundary) remains unchanged.

## Development

Run these commands from the repository root:

```bash
bun install
bun run check
bun run lint
bun run test
```
