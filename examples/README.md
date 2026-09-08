# Examples

The reservation application uses canonical resources, explicit business commands, and framework-generated persistence and interfaces. The focused examples cover generated repositories, migration review, and the lower-level table/query escape hatch.

## Focused examples

Run from the repository root:

```bash
bun run examples/resource-crud.ts
bun run examples/migration-lifecycle.ts
bun run examples/basic-crud.ts
bun run examples/service-codec.ts
bun run examples/persisted-ref.ts
```

- [`resource-crud.ts`](resource-crud.ts) derives a typed repository and exercises generated create, get, update, list, find, and remove behavior against temporary SQLite.
- [`migration-lifecycle.ts`](migration-lifecycle.ts) shows an ambiguous schema change being blocked, supplies explicit rename and backfill intent, applies the reviewed migration, and preserves existing data.
- [`basic-crud.ts`](basic-crud.ts) derives a stored `Book` row with a UUIDv7 key and authors queries against temporary SQLite.
- [`service-codec.ts`](service-codec.ts) keeps a schema codec's Effect service in the query's execution requirements.
- [`persisted-ref.ts`](persisted-ref.ts) combines queries into a write-through reference, serializes concurrent updates, and explicitly refreshes an external change.

Each focused example is self-contained: declarations come first, followed by the runnable Effect. Temporary databases use `FileSystem.makeTempDirectoryScoped` with `BunFileSystem.layer`; closing the scope removes the directory. Framework imports use the public `effect-domains/*` entry points.

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
