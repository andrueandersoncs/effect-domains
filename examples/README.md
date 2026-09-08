# Examples

Each example is a complete, loopback-only application with a persistent SQLite database, frozen migration history, an HTTP RPC server, a generated CLI, and local schema commands. They demonstrate different framework boundaries rather than six copies of the same CRUD implementation.

## Choose an application

| Application | Purpose | Database setting |
| --- | --- | --- |
| [basic-crud](basic-crud/README.md) | Book CRUD through authored `Query` implementations | `BASIC_CRUD_DB` |
| [resource-crud](resource-crud/README.md) | Todo CRUD generated entirely from a resource | `RESOURCE_CRUD_DB` |
| [service-codec](service-codec/README.md) | Notes with a runtime-service-dependent storage codec | `SERVICE_CODEC_DB` |
| [persisted-ref](persisted-ref/README.md) | A shared, query-backed counter with explicit cache refresh | `PERSISTED_REF_DB` |
| [migration-lifecycle](migration-lifecycle/README.md) | Document CRUD with historical rename and backfill | `MIGRATION_LIFECYCLE_DB` |
| [reservations](reservations/README.md) | Explicit stock policy and transactional reservation commands | `RESERVATIONS_DB` |

Each local README explains what is generated, what is deliberately authored, how to run the application, and its important limitations. Start with [resource-crud](resource-crud/README.md) for ordinary CRUD; [basic-crud](basic-crud/README.md) demonstrates the authored-query escape hatch, not the minimum required boilerplate.

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
- `application.ts`: resources and explicit command registration.
- `migrations.ts` and `migrations/*.json`: decoded, frozen schema history.
- `server.ts`: persistent database and runtime service composition.
- `cli.ts`: generated RPC client and local migration commands.

Authored-query applications also define command contracts, service interfaces, and SQLite implementations. Resource-only applications use generated handlers directly; they do not need empty service wrappers. Framework imports use the public `effect-domains/*` entry points.

## Reservation application

The [reservation guide](reservations/README.md) covers the business-policy slice: generated read operations alongside explicit transactional reserve, confirm, and release commands. It includes the stock walkthrough, transition errors, restart behavior, and historical timestamp migration. The [validation record](../docs/wiki/validation-strategy.md#reservation-slice) separates exercised behavior from unresolved framework questions.

## CLI conventions

Scalar payload fields become kebab-case flags. For example, `createdAt` becomes `--created-at`. Explicit false booleans are accepted as `--enabled false`; use `--amount=-1` for negative numeric arguments. `--input-json` accepts the canonical JSON payload, including shapes that cannot be represented by native flags. It cannot be mixed with field flags.

```bash
bun run reservations reserve --help
bun run reservations reserve --input-json '{"sku":"book","quantity":1}'
```

The endpoint uses Effect's JSON RPC protocol, not REST. Use the generated CLI or Effect's `RpcClient` rather than duplicating its envelope. Known-operation validation and business failures exit nonzero and report to stderr; successful results are JSON on stdout. Example-specific settings and operation semantics are documented in each local README.

## Review schema changes

Schema commands run locally without a server:

```bash
bun run reservations schema snapshot --out current-schema.json
bun run reservations schema plan --id 003_change \
  --from examples/reservations/migrations/002_timestamp.json \
  --out 003_change.json
```

The plan compares the previous snapshot or migration artifact with the current canonical schemas. With no `--from`, it plans initial creation from an empty schema. Review and keep the generated artifact, then include it in the runtime's migration history. Do not regenerate previously applied artifacts from current models.

Intent flags use physical table and column names:

| Flag | Meaning |
| --- | --- |
| `--rename table:old:new` | Explicit column rename |
| `--backfill 'table:column:JSON'` | Constant stored value for a new required field |
| `--transform 'table:column:SQL-expression'` | Explicit stored-value transformation |

A transform runs in the `SELECT` over the physical **from** table, before renames or rebuilding. The checked-in [timestamp artifact](reservations/migrations/002_timestamp.json) converts historical epoch seconds to ISO text. Its snapshot does not import the latest reservation schema.

The planner emits blocked changes instead of guessing drops, renames, or required values. The runtime checks artifact history and actual table definitions, applies rebuilds transactionally, and refuses untracked tables, indexes, and triggers. Relationships, indexes, destructive drops, and arbitrary custom table objects are outside the current migration model.

## Framework code map

- [`ApplicationBun`](../src/application-bun.ts): shared HTTP server and CLI runtime.
- [`Resource`](../src/resource.ts): generated repositories, selected RPC contracts, groups, and handlers.
- [`Query`](../src/query.ts): authored query boundary with request encoding and result decoding.
- [`RpcCli`](../src/rpc-cli.ts): schema-derived CLI flags and JSON fallback.
- [`SqliteMigrations`](../src/sqlite-migrations.ts): frozen snapshots, migration planning, and execution.
