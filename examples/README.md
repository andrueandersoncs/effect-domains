# Examples

Each example is a complete, loopback-only application with a persistent SQLite database, a manifest registry of frozen migration artifacts, an HTTP RPC server, a generated CLI, and local schema commands. They demonstrate different framework boundaries rather than six copies of the same CRUD implementation.

## Choose an application

| Application | Purpose | Database setting |
| --- | --- | --- |
| [basic-crud](basic-crud/README.md) | Book CRUD through authored `Query` implementations | `BASIC_CRUD_DB` |
| [resource-crud](resource-crud/README.md) | Todo CRUD generated from a resource, including page/list and patch policies | `RESOURCE_CRUD_DB` |
| [service-codec](service-codec/README.md) | Generated note CRUD with a runtime-service-dependent storage codec | `SERVICE_CODEC_DB` |
| [persisted-ref](persisted-ref/README.md) | A shared counter bound to one persisted resource identity with explicit refresh | `PERSISTED_REF_DB` |
| [migration-lifecycle](migration-lifecycle/README.md) | Document CRUD with historical rename and backfill | `MIGRATION_LIFECYCLE_DB` |
| [reservations](reservations/README.md) | Explicit stock policy and transactional reservation commands | `RESERVATIONS_DB` |

Each local README explains what is generated, what is deliberately authored, how to run the application, and its important limitations. Start with [resource-crud](resource-crud/README.md) for generated CRUD; [basic-crud](basic-crud/README.md) demonstrates the authored-query escape hatch.

## Shared runtime

Install dependencies once with `bun install`.

Run commands from the repository root. Start one server, then use its CLI in another terminal:

```bash
bun run resource-crud:server
bun run resource-crud --help
```

Each database defaults to `<application>.sqlite` in the working directory. Startup applies the frozen migration chain; it does not reset existing data. An untracked database is rejected rather than silently adopted.

All servers default to `http://127.0.0.1:3000`, and all CLIs default to `http://127.0.0.1:3000/rpc/v1`. To run applications concurrently, assign distinct ports and matching client URLs:

```bash
PORT=3001 BASIC_CRUD_DB=books.sqlite bun run basic-crud:server
BASIC_CRUD_URL=http://127.0.0.1:3001/rpc/v1 bun run basic-crud books.list
```

Client settings follow the database naming convention: `BASIC_CRUD_URL`, `RESOURCE_CRUD_URL`, `SERVICE_CODEC_URL`, `PERSISTED_REF_URL`, `MIGRATION_LIFECYCLE_URL`, and `RESERVATIONS_URL`. There is no authentication. These are runnable examples, not production deployment templates.

### Shared structure

- `domain.ts`: canonical values and errors.
- `resources.ts`: storage registration and selected generated operations.
- `contracts.ts`: command contracts where the application has authored commands.
- `application.ts`: resources and explicit command-descriptor registration.
- `migrations/manifest.json`: ordered registry of frozen migration artifacts used at runtime.
- `migrations.ts`: decoded fixture/history data only where a seed or other local code needs it.
- `main.ts`: the sole runner for `serve`, schema commands, `inspect`, and generated remote commands.

`Application.make({ name, resources?, commands?: [descriptor] })` combines resource and command-descriptor groups. `main.ts` resolves the manifest to an absolute path and calls `ApplicationBun.run(app, { database: { manifest }, services?, initialize? })`; callers that already own decoded history may instead pass `database: { migrations }`. The same runner supplies the loopback server, generated RPC client, local `schema` commands, and `inspect`; `*:server` package scripts are aliases for `main.ts serve`. Authored-command applications define command contracts and install implementations through command descriptors. Resource-only applications use generated handlers directly; they do not need empty service wrappers. Framework imports use the public `effect-domains/*` entry points.

## Reservation application

The [reservation guide](reservations/README.md) covers the business-policy slice: generated read operations alongside explicit transactional reserve, confirm, and release commands. It includes the stock walkthrough, transition errors, restart behavior, and historical timestamp migration. The [validation record](../docs/wiki/validation-strategy.md#reservation-slice) separates exercised behavior from unresolved framework questions.

## CLI conventions

Scalar payload fields become kebab-case flags. Nested payload fields use their path, so `filter.completed` is `--filter-completed` and `patch.title` is `--patch-title`. Explicit false booleans are accepted as `--enabled false`; finite numeric fields have native flags, and use `--amount=-1` for negative numeric arguments. `--input-json` accepts the canonical JSON payload, including shapes that cannot be represented by native flags. It cannot be mixed with field flags.

```bash
bun run resource-crud todos.list --filter-completed false --limit 10
bun run resource-crud todos.patch --id "$TODO_ID" --patch-title "Ship docs"
bun run reservations reserve --input-json '{"sku":"book","quantity":1}'
```

The endpoint uses Effect's JSON RPC protocol, not REST. Use the generated CLI or Effect's `RpcClient` rather than duplicating its envelope. Known-operation validation and business failures exit nonzero and report to stderr; successful results are JSON on stdout. `inspect [operation]` writes the resource schemas, storage/physical fields, creation and list policies, local and remote commands, and selected operation contracts. Runtime service requirements and authored transaction boundaries are intentionally reported as opaque metadata.

## Review schema changes

Schema commands run locally without a server. After changing a resource schema, `schema generate <name>` plans the next artifact from the registered manifest, writes that artifact, then atomically replaces the manifest registry only if the plan is valid:

```bash
bun run migration-lifecycle schema generate add-status \
  --backfill 'documents:status:"draft"'
```

Use `schema snapshot` or `schema plan` to inspect a prospective artifact without registering it:

```bash
bun run reservations schema snapshot --out current-schema.json
bun run reservations schema plan --id 003_change \
  --from examples/reservations/migrations/002_timestamp.json \
  --out 003_change.json
```

`generate` numbers the new artifact after the final registered migration; it requires a manifest and leaves the registry unchanged when a plan is blocked. Review the generated artifact and its manifest update as one change. Do not regenerate previously applied artifacts from current models.

Intent flags use physical table and column names:

| Flag | Meaning |
| --- | --- |
| `--rename table:old:new` | Explicit column rename |
| `--backfill 'table:column:JSON'` | Constant stored value for a new required field |
| `--transform 'table:column:SQL-expression'` | Explicit stored-value transformation |

A transform runs in the `SELECT` over the physical **from** table, before renames or rebuilding. The checked-in [timestamp artifact](reservations/migrations/002_timestamp.json) converts historical epoch seconds to ISO text. Its snapshot does not import the latest reservation schema.

The planner emits blocked changes with their reasons instead of guessing drops, renames, or required values. The runtime checks manifest history and actual table definitions, applies rebuilds transactionally, and refuses untracked tables, indexes, and triggers. Relationships, indexes, destructive drops, and arbitrary custom table objects are outside the current migration model.

## Framework code map

- [`ApplicationBun`](../src/application-bun.ts): shared HTTP server and CLI runtime.
- [`Resource`](../src/resource.ts): generated repositories, selected RPC contracts, groups, and handlers.
- [`Query`](../src/query.ts): authored query boundary with request encoding and result decoding.
- [`RpcCli`](../src/rpc-cli.ts): schema-derived CLI flags and JSON fallback.
- [`SqliteMigrations`](../src/sqlite-migrations.ts): frozen snapshots, migration planning, and execution.
