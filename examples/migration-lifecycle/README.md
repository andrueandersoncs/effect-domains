# Migration lifecycle documents

This example explains how a frozen SQLite migration history carries data from a legacy document shape to a current generated CRUD application. It keeps historical intent separate from the current model: version one stored `title`; version two renames it to `heading`, adds nullable `summary`, and backfills required `priority` with `0`.

For common runtime and explicit-migration conventions, see the [examples overview](../README.md). Compare the generated CRUD here with [authored book queries](../README.md#authored-sql) and the migration transform in [reservations](../reservations/).

## Run the historical upgrade

Run these commands from the repository root with the same fresh database path. The seed command uses only the frozen version-one artifact; the current server then applies the complete checked-in chain.

```bash
MIGRATION_LIFECYCLE_DB=migration-demo.sqlite bun run migration-lifecycle:seed-v1
MIGRATION_LIFECYCLE_DB=migration-demo.sqlite bun run migration-lifecycle:server
```

The runner also opts into the generated admin at [http://127.0.0.1:3000/admin](http://127.0.0.1:3000/admin). It exposes the current published document operations, not the legacy seed path; see the [shared admin guide](../README.md#generated-admin).

In another terminal, inspect the migrated legacy row and create a current document:

```bash
MIGRATION_LIFECYCLE_URL=http://127.0.0.1:3000/rpc/v1 bun run migration-lifecycle documents.list
MIGRATION_LIFECYCLE_URL=http://127.0.0.1:3000/rpc/v1 bun run migration-lifecycle documents.create --input-json '{"heading":"New document","summary":null,"priority":1}'
```

The seeded `Migration guide` keeps its UUIDv7 identifier and title value as `heading`; it receives `summary: null` and `priority: 0`. Set `DOCUMENT_ID` to a returned identifier to use the remaining generated operations:

```bash
bun run migration-lifecycle documents.get --input-json "{\"id\":\"$DOCUMENT_ID\"}"
bun run migration-lifecycle documents.update --input-json "{\"id\":\"$DOCUMENT_ID\",\"heading\":\"Reviewed document\",\"summary\":null,\"priority\":2}"
bun run migration-lifecycle documents.remove --input-json "{\"id\":\"$DOCUMENT_ID\"}"
```

Historical seeding is optional: starting the current server against a fresh database applies the frozen chain to produce the current schema, without inserting the legacy seed row. The seed command refuses an already upgraded database instead of attempting to insert legacy rows into it.

| Setting | Default | Meaning |
| --- | --- | --- |
| `MIGRATION_LIFECYCLE_DB` | `migration-lifecycle.sqlite` | SQLite database used by the seed command and server |
| `PORT` | `3000` | Loopback HTTP port |
| `MIGRATION_LIFECYCLE_URL` | `http://127.0.0.1:3000/rpc/v1` | RPC endpoint used by the CLI |

The server is loopback-only and unauthenticated, using Effect's JSON RPC protocol rather than REST. Generated updates require the complete stored row; `remove` returns `void`, and missing rows use `ResourceNotFound`.

## What is generated and what is authored

The current `DocumentsResource` declares all five generated operations: `documents.get`, `documents.list`, `documents.create`, `documents.update`, and `documents.remove`. There are no authored document RPC commands or service implementation in this example.

The migration story is authored and reviewed instead. [`legacy.ts`](legacy.ts) describes the version-one `title` shape solely for the seed program. [`migrations/001_initial.json`](migrations/001_initial.json) and [`migrations/002_document_metadata.json`](migrations/002_document_metadata.json) are frozen artifacts. The second artifact rebuilds the table, copies `title` to `heading`, leaves the new nullable `summary` as `NULL`, and supplies `0` for the newly required `priority`.

[`003_schema_string_checks`](migrations/003_schema_string_checks.json) then rebuilds without the misderived SQLite heading-length constraint, copying existing values unchanged. The first two artifacts retain their historical meaning; canonical non-empty validation remains in the schema.

The current schema requires a non-empty `heading`, allows `summary` to be `null`, and requires an integer `priority` of at least zero. Generated identifiers are UUIDv7 values. List returns `{ items, nextCursor }`, defaults to 50 items, and orders by identifier ascending.

## Author the next migration

The runtime uses ordered artifact imports decoded with `SqliteMigrations.decodeHistory` in [`migrations.ts`](migrations.ts). There is no schema CLI, inferred migration planner, or rename/backfill/transform intent language. Use `SqliteMigrations.make({ id, from, to, steps })` and the schema constructors under `SqliteMigrations.steps` and `SqliteMigrations.copies`. The [shared authoring walkthrough](../README.md#review-schema-changes) demonstrates a document rebuild that explicitly copies `title` to `heading` and fills `priority` with `0`.

For a new required `status` field, author a target table snapshot and a rebuild with complete original-column copies plus `SqliteMigrations.copies.Value.make({ column: "status", value: "draft" })`. Use the final frozen artifact's `to` as the new `from`. Review and test replay against representative old rows, then append the new artifact import to the decoded history array. Do not rerun the illustrative draft against this already-evolved history.

Inspect current contracts locally without a server:

```bash
bun run migration-lifecycle inspect documents.create
```

Applied artifacts are immutable history. Do not regenerate or edit an artifact that has been applied to a database: startup validates decoded history and the database schema, applies the frozen chain without resetting data, and rejects untracked database objects rather than silently adopting them.

## Code map

- [`domain.ts`](domain.ts): the current document schema and priority invariant.
- [`resources.ts`](resources.ts) and [`application.ts`](application.ts): generated document CRUD registration.
- [`legacy.ts`](legacy.ts) and [`seed-v1.ts`](seed-v1.ts): the isolated version-one schema and seed path.
- [`migrations.ts`](migrations.ts) and [frozen artifacts](migrations/): ordered imports and decoded historical migration chain.
- [`main.ts`](main.ts): the sole server, generated CLI, and inspection runner.
- [`SqliteMigrations`](../../packages/effect-domains/src/sqlite-migrations.ts): explicit artifacts, history validation, and transactional SQLite replay.
