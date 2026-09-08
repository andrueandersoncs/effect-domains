# Examples

Each example is a complete, loopback-only application with a persistent SQLite database, frozen migration history, an HTTP RPC server, a generated CLI, and local schema commands. They demonstrate different framework boundaries rather than six copies of the same CRUD implementation.

## Choose an application

| Application | Purpose | Database setting |
| --- | --- | --- |
| [basic-crud](basic-crud/) | Book CRUD through authored `Query` implementations | `BASIC_CRUD_DB` |
| [resource-crud](resource-crud/) | Todo CRUD generated entirely from a resource | `RESOURCE_CRUD_DB` |
| [service-codec](service-codec/) | Notes with a runtime-service-dependent storage codec | `SERVICE_CODEC_DB` |
| [persisted-ref](persisted-ref/) | A shared, query-backed counter with explicit cache refresh | `PERSISTED_REF_DB` |
| [migration-lifecycle](migration-lifecycle/) | Document CRUD with historical rename and backfill | `MIGRATION_LIFECYCLE_DB` |
| [reservations](reservations/) | Explicit stock policy and transactional reservation commands | `RESERVATIONS_DB` |

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

## Authored book queries

Start `bun run basic-crud:server`, then:

```bash
bun run basic-crud books.create --input-json '{"title":"A Field Guide","pageCount":120}'
bun run basic-crud books.list
```

Set `BOOK_ID` to the created row's UUIDv7 `id`:

```bash
bun run basic-crud books.get --id "$BOOK_ID"
bun run basic-crud books.update --input-json "{\"id\":\"$BOOK_ID\",\"title\":\"A Revised Field Guide\",\"pageCount\":144}"
bun run basic-crud books.remove --id "$BOOK_ID"
```

These operations use authored SQL through `Query.make`, not the generated repository. Missing records report typed errors. Book page counts and counter values retain the original `Schema.Number` contract; its JSON codec is not a single native numeric flag, so use canonical `--input-json` for those payloads.

## Generated todo CRUD

Start `bun run resource-crud:server`, then:

```bash
bun run resource-crud todos.create --title "Ship applications" --completed false
bun run resource-crud todos.list
```

Set `TODO_ID` to the returned identifier:

```bash
bun run resource-crud todos.get --id "$TODO_ID"
bun run resource-crud todos.update --id "$TODO_ID" --title "Ship applications" --completed true
bun run resource-crud todos.remove --id "$TODO_ID"
```

`Resource.make` generates all five operations. Updates supply the complete stored row. The canonical todo schema has no identifier; persistence adds the UUIDv7 key.

## Service-dependent note codecs

Start `bun run service-codec:server`, then:

```bash
bun run service-codec notes.create --id note-1 --text "Visible domain text"
bun run service-codec notes.get --id note-1
bun run service-codec notes.update --id note-1 --text "Revised domain text"
bun run service-codec notes.list
bun run service-codec notes.remove --id note-1
```

The CLI accepts and returns ordinary text. The stored representation adds `stored:` through a schema codec that requires the server's `StoragePrefix` service. Public contracts use the canonical note schema, so storage-service requirements do not leak into the client. The storage codec remains explicit rather than becoming a transport convention.

## Query-backed persisted counter

Start `bun run persisted-ref:server`, then:

```bash
bun run persisted-ref counters.get
bun run persisted-ref counters.increment
bun run persisted-ref counters.set --input-json '{"value":100}'
bun run persisted-ref counters.get
bun run persisted-ref counters.refresh
```

The application seeds a single `visits` counter at zero only when absent. One process-local `PersistedRef` serializes concurrent increments and writes them through to SQLite. `counters.set` deliberately bypasses the reference and changes the stored value: `get` remains stale until `refresh`. Restarting loads the persisted value, rather than reseeding it.

This is a single-server cache demonstration. It does not provide cross-process synchronization; a stale cached update can overwrite an external write.

## Versioned documents

To exercise the historical migration, choose a fresh database and seed version-one data before starting the current server:

```bash
bun run migration-lifecycle:seed-v1
bun run migration-lifecycle:server
```

In another terminal:

```bash
bun run migration-lifecycle documents.list
bun run migration-lifecycle documents.create --input-json '{"heading":"New document","summary":null,"priority":1}'
```

The historical document retains its identifier and title value, now stored as `heading`; migration adds `summary: null` and backfills `priority: 0`. The legacy seed command uses only the frozen version-one artifact and refuses an already-upgraded database. Starting the current server directly on a fresh database also works; historical seeding is optional.

Set `DOCUMENT_ID` to a returned identifier:

```bash
bun run migration-lifecycle documents.get --id "$DOCUMENT_ID"
bun run migration-lifecycle documents.update --input-json "{\"id\":\"$DOCUMENT_ID\",\"heading\":\"Reviewed document\",\"summary\":null,\"priority\":2}"
bun run migration-lifecycle documents.remove --id "$DOCUMENT_ID"
```

Compare an unresolved plan with explicit migration intent, without a running server:

```bash
bun run migration-lifecycle schema plan --id 002_document_metadata \
  --from examples/migration-lifecycle/migrations/001_initial.json \
  --out unresolved.json
bun run migration-lifecycle schema plan --id 002_document_metadata \
  --from examples/migration-lifecycle/migrations/001_initial.json \
  --rename documents:title:heading --backfill documents:priority:0 \
  --out reviewed.json
```

The first command writes a plan containing blocked changes and exits nonzero; the second resolves the rename and required-field backfill. The server uses the checked-in reviewed artifact, not either scratch output. Previously applied migration artifacts must remain unchanged.

## Reservation application

### Reserve and release stock

```bash
bun run reservations:server
```

The server listens on `http://127.0.0.1:3000`, applies frozen migration history to `reservations.sqlite`, and seeds five books only when the SKU is absent. Restarting does not reset stock. Untracked databases, including files from earlier versions of this example, are deliberately not adopted; choose a fresh `RESERVATIONS_DB` path for this version.

In another terminal:

```bash
bun run reservations --help
bun run reservations stock.get --sku book
bun run reservations reserve --sku book --quantity 2
```

The last command prints a reservation with a UUIDv7 `id`, `held` status, and ISO `createdAt`. Set `RESERVATION_ID` to that returned identifier, then run:

```bash
bun run reservations reservations.get --id "$RESERVATION_ID"
bun run reservations release --id "$RESERVATION_ID"
bun run reservations stock.get --sku book
```

Release restores stock. Use `confirm` instead of `release` to consume it permanently. Repeating a terminal transition, or releasing a confirmed reservation, fails with `InvalidReservationState`. Known-operation validation and business failures exit nonzero and report to stderr; successful results are JSON on stdout.

Only `stock.get` and `reservations.get` are published as resource operations. Reservation creation and changes go through the explicit commands, not unrestricted CRUD.

### CLI and runtime reference

Scalar payload fields become kebab-case flags. For example, `createdAt` becomes `--created-at`. Explicit false booleans are accepted as `--enabled false`; use `--amount=-1` for negative numeric arguments. `--input-json` accepts the canonical JSON payload, including shapes that cannot be represented by native flags. It cannot be mixed with field flags.

```bash
bun run reservations reserve --help
bun run reservations reserve --input-json '{"sku":"book","quantity":1}'
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `RESERVATIONS_DB` | `reservations.sqlite` | Server database file |
| `PORT` | `3000` | Loopback HTTP port |
| `RESERVATIONS_URL` | `http://127.0.0.1:3000/rpc/v1` | CLI RPC endpoint |

The endpoint uses Effect's JSON RPC protocol, not REST. Use the generated CLI or Effect's `RpcClient` rather than duplicating its envelope. There is no authentication. Repeating `reserve` creates another reservation if stock is available; no idempotency key or ambiguous-outcome recovery is supplied.

### Review schema changes

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

### Code map

- [`domain.ts`](reservations/domain.ts): canonical values, intrinsic identifiers, errors, and transitions.
- [`resources.ts`](reservations/resources.ts): resource declarations and permitted read operations.
- [`contracts.ts`](reservations/contracts.ts): explicit `reserve`, `confirm`, and `release` contracts.
- [`inventory.ts`](reservations/inventory.ts): the command-derived service interface.
- [`sqlite.ts`](reservations/sqlite.ts): transaction boundaries, guarded stock policy, generated repository calls, and idempotent startup seed.
- [`migrations.ts`](reservations/migrations.ts) and [frozen artifacts](reservations/migrations/001_initial.json): historical schema data.
- [`application.ts`](reservations/application.ts), [`server.ts`](reservations/server.ts), and [`cli.ts`](reservations/cli.ts): application registration and runtime configuration.
- [`ApplicationBun`](../src/application-bun.ts), [`Resource`](../src/resource.ts), and [`RpcCli`](../src/rpc-cli.ts): shared runtime, repository/RPC, and CLI machinery.

The [validation record](../docs/wiki/validation-strategy.md#reservation-slice) records the observed automation, preserved business invariants, and remaining gaps.
