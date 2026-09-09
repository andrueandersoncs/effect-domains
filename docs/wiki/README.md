# Effect Domains Wiki

This directory is the persistent, source-grounded wiki for the Effect Domains design hypothesis and implementation workspace.

Effect Domains derives routine application machinery from canonical Effect Schemas while leaving semantic storage transformations, business policy, and migration intent explicit. The maintained [framework contract](research-agenda.md#implemented-contract) records the current API; the [validation record](validation-strategy.md#verification-record) separates exercised behavior from historical and unproven claims. The implementation is a private Bun workspace: the framework is [`packages/effect-domains`](../../packages/effect-domains/), shared fixtures are [`packages/example-support`](../../packages/example-support/), runnable applications are under [`apps`](../../apps/), and the browser admin is separately prebuilt in [`apps/admin`](../../apps/admin/).

## Content Map

- [Thesis](thesis.md) — central claim, derivation boundary, and architectural principles.
- [Tables and Queries](tables-and-queries.md) — resource authorization, command, persistence, migration, runtime, and native durable-execution contracts.
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

The [implementation-reduction record](validation-strategy.md#2026-09-09-behavior-preserving-implementation-reduction) records 140 net source lines removed without a public-contract change. Workspace checks and 57 regressions passed; differential smoke outputs matched the original implementation, and live authenticated CLI mutation/visibility boundaries were exercised.

The [command-wrapper removal record](validation-strategy.md#2026-09-09-command-wrapper-removal) completes the earlier authored-SQL pilot: `commands.ts` and its package export are removed, and all authored applications register native RPC groups and handler layers. Live reservations and billing retain timestamp codecs, rollback, authorization, and request-local MCP identity; wrapper-only tests are retired rather than reproduced.

The [feature-retirement record](validation-strategy.md#2026-09-09-persistent-reference-and-cluster-wrapper-removal) documents removal of `PersistedRef`, its counter demonstration, and the framework cluster wrapper. Caching remains application policy; the workflow application owns its native diagnostic schemas and authenticated status command. Generated CLI flags are unchanged.

The [orders/invoices slice](validation-strategy.md#2026-09-09-tenant-scoped-orders-and-invoices) adds a second business-policy domain: authenticated multi-table transactions, tenant-local uniqueness, composite foreign keys, secondary indexes, and explicit optimistic versions. Relational declarations belong to Table/Resource configuration, not canonical schemas; joins and transitions remain authored. The [walkthrough](../../apps/README.md#orders-and-invoices) runs the complete order → invoice → payment lifecycle.

The [native durable-execution record](validation-strategy.md#2026-09-09-native-durable-execution) records passing final workspace typechecking, lint, and 64 tests, plus forced-restart recovery for an approval/export workflow and scheduled per-recipient delivery. Live checks include standalone workers, authenticated native proxies, protected diagnostics, a singleton projection, and explicit cron retention. These are bounded single-runner demonstrations, not cross-database atomicity or production distributed-system guarantees.

The [2026-09-09 boundary-correction record](validation-strategy.md#2026-09-09-schema-and-invocation-boundaries) records 61 boundary-suite tests, live browser/CLI `{ key, changes }` patching, and a preserved historical document upgrade through migration 003. Workspace types and repository lint passed before concurrent workflow/cluster edits; those unrelated edits blocked the final aggregate checks. The later expanded test run passed 62 tests. Earlier records retain their original results and evidence limits.

`Resource.make({ name, schema, authorization, storage?, relations?, operations, create?, list? })` requires explicit public, deny, or typed-policy authorization. Under policy authorization, `create.fromSubject` maps canonical target fields to typed `p.subject` operands. Those fields are excluded from the TypeScript and wire create input and a supplied value is rejected before the repository binds the authenticated subject value; defaults, generation, and subject bindings cannot overlap. Resource policy stays outside canonical schemas; generated repositories enforce scoped SQL visibility and transactional mutation checks. ([Resource](../../packages/effect-domains/src/resource.ts); [Authorization](../../packages/effect-domains/src/authorization.ts); [resource contract](tables-and-queries.md#generated-resource-operations))

Storage remains an explicit reversible representation, not a wire contract. The shared-note storage schema uses native `mapFields(Struct.assign(...))` to replace `text`, while resource RPCs retain canonical notes. ([Stored note codec](../../apps/service-codec/storage.ts); [canonical/storage boundary](tables-and-queries.md#canonical-and-storage-representations))

`Application.make` composes native `{ group, handlers }` bundles, including authored operations and workflow/entity proxies. Handlers use explicit `Effect.catchTags` after transaction work; native RPC owns dispatch, middleware, and invocation scopes. `ApplicationBun.run` returns an Effect for native `BunRuntime.runMain` and accepts optional private `execution`, native `background`, and HTTP `routes` layers. Background registration enables a worker-only command. ([Application](../../packages/effect-domains/src/application.ts); [billing handlers](../../apps/orders-invoices/sqlite.ts); [Runtime](../../packages/effect-domains/src/application-bun.ts); [native composition](tables-and-queries.md#native-durable-execution))

`serve` mounts Effect RPC at `/rpc/v1`, derived MCP at `/mcp`, and, only when `admin: true` or an admin options record is selected, the generated browser admin at `/admin` by default. The seven resource-focused examples opt into admin; the two durable examples do not. The [admin build](../../apps/admin/build.ts) precompiles the [browser client](../../apps/admin/src/client.ts) and [stylesheet](../../apps/admin/src/style.css); the [native adapter](../../packages/effect-domains/src/application-admin.ts) only serves those assets.

Admin and MCP share a request-isolated in-process RPC transport. Their codecs use captured handler services without replacing request-local authentication context. The client stores no token; inspection supplies schemas and names, while presentation remains separate configuration. ([Transport](../../packages/effect-domains/src/rpc-in-process.ts); [adapter contract](tables-and-queries.md#commands-applications-and-admin))

The dedicated [`mcp-server` walkthrough](../../apps/README.md#mcp-client-walkthrough) exposes public generated book CRUD without enabling admin. Its [official-SDK client](../../apps/mcp-server/client.ts) exercises Streamable HTTP initialization, tool discovery, structured results, and declared domain errors. A live loopback run on 2026-09-09 discovered all five tools, created/read/updated/listed/removed a book, received `ResourceNotFound` after deletion, and terminated the session. This verifies that client/server path, not authentication or third-party agent configuration.

SQLite history is decoded by `SqliteMigrations.decodeHistory(raw)` or loaded from an explicit manifest. Nonempty schemas require an initial migration; one applied-artifact ledger replaces bootstrap/adoption and separate schema-state tracking. `schema generate <name>` validates an artifact before atomically replacing the manifest; blocked plans are not registered. ([Migrations](../../packages/effect-domains/src/sqlite-migrations.ts); [migration regressions](../../test/SqliteMigrations.test.ts))

The earlier [workspace verification record](validation-strategy.md#2026-09-09-bun-workspaces-and-prebuilt-admin) records browser CRUD, missing-assets behavior, and an isolated packed-package consumer. The [declarative/admin record](validation-strategy.md#2026-09-09-declarative-inputs-and-generated-admin) retains its broader runtime observations. These historical scenarios were not all repeated during lint remediation; the [broader evidence boundary](validation-strategy.md#evidence-boundary) remains unchanged.

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
