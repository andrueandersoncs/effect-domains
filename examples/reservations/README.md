# Transactional reservations

This example separates generated read access from authored stock policy. It reserves a finite inventory item through transactions, so a reservation is more than a row: it has a lifecycle and changes available stock.

For common runtime and explicit-migration conventions, see the [examples overview](../README.md). Compare the policy-protected project work in [team-tasks](../team-tasks/) and the historical rename/backfill workflow in [editorial-calendar](../editorial-calendar/).

## Run it

From the repository root, start the server:

```bash
bun run reservations:server
```

The runner also enables the generated admin at [http://127.0.0.1:3000/admin](http://127.0.0.1:3000/admin). It invokes the same generated reads and explicit reservation commands; see the [shared admin guide](../README.md#generated-admin).

In another terminal, inspect stock, create a hold, then release it:

```bash
bun run reservations stock.get --input-json '{"sku":"book"}'
bun run reservations reserve --input-json '{"sku":"book","quantity":2}'
```

Set `RESERVATION_ID` to the UUIDv7 `id` returned by `reserve`. The new reservation has `held` status and an ISO `createdAt` timestamp. Then read and release it:

```bash
bun run reservations reservations.get --input-json "{\"id\":\"$RESERVATION_ID\"}"
bun run reservations release --input-json "{\"id\":\"$RESERVATION_ID\"}"
bun run reservations stock.get --input-json '{"sku":"book"}'
```

`release` restores the reservation's quantity to stock. For a separate newly created hold, use `confirm` **instead of** `release` to consume the held stock permanently. Set `RESERVATION_ID` to that new hold's identifier before running:

```bash
bun run reservations confirm --input-json "{\"id\":\"$RESERVATION_ID\"}"
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `RESERVATIONS_DB` | `reservations.sqlite` | SQLite database used by the server |
| `PORT` | `3000` | Loopback HTTP port |
| `RESERVATIONS_URL` | `http://127.0.0.1:3000/rpc/v1` | RPC endpoint used by the CLI |

For example, use a separate database and matching endpoint when another example uses the default port:

```bash
PORT=3001 RESERVATIONS_DB=reservations-demo.sqlite bun run reservations:server
RESERVATIONS_URL=http://127.0.0.1:3001/rpc/v1 bun run reservations stock.get --input-json '{"sku":"book"}'
```

The server is loopback-only and unauthenticated, using Effect's JSON RPC protocol rather than REST.

## What is generated and what is authored

Only `stock.get` and `reservations.get` are generated resource operations. There is deliberately no generated create, update, list, or remove route for either resource.

[`contracts.ts`](contracts.ts) declares `reserve`, `confirm`, and `release` with native `Rpc.make`, grouped as `InventoryRpcs`. Its reservation success contract explicitly uses `Schema.toCodecJson(ReservationSchema)` so `createdAt` crosses the JSON RPC boundary as an ISO UTC string. Confirm and release share `transition` schemas but have distinct tags. [`sqlite.ts`](sqlite.ts) installs handlers with `InventoryRpcs.toLayer(...)`; authored effects translate only matching persistence failures after transactions unwind, preserving acquisition failures, defects, interruption, and unmatched errors.

The implementations and policy remain explicit. `reserve` atomically verifies a SKU, decrements stock only when enough remains, creates a UUIDv7 reservation, and marks it `held`. `confirm` changes a hold to `confirmed` without restoring stock. `release` changes a hold to `released` and restores its quantity in the same transaction. The guarded SQL decrement prevents concurrent successful reservations from taking stock below zero.

## Policy boundaries and errors

- A SKU must be non-empty; quantities must be positive safe integers. `stock.available` is a non-negative safe integer.
- Reserving an unknown SKU reports `UnknownSku`; an unavailable quantity reports `InsufficientStock` with the requested and observed available count. Persistence failures report `InventoryUnavailable`.
- Only a `held` reservation may transition. Repeating `confirm` or `release`, or releasing a confirmed reservation, reports `InvalidReservationState`. An unknown identifier reports `ReservationNotFound`.
- Repeating `reserve` is not idempotent: it creates another hold whenever stock is available. There is no idempotency key or ambiguous-outcome recovery.
- Startup applies the frozen migration chain and seeds the single `book` SKU with `available: 5` only when that SKU is absent. Restarting does not reset stock or reservations. An untracked database, including one from an earlier version of this example, is rejected; choose a fresh `RESERVATIONS_DB` path instead.

## Timestamp migration

The frozen [`002_timestamp`](migrations/002_timestamp.json) artifact rebuilds `reservations` and converts the historical `created_at_seconds` epoch value into the current ISO UTC `createdAt` text using SQLite's `strftime`. It is a reviewed stored-data transformation, not a transport formatting change.

[`003_schema_string_checks`](migrations/003_schema_string_checks.json) preserves stock and reservation rows while removing the misderived SQLite SKU-length constraints. Non-empty SKU validation remains in the canonical schemas; the earlier artifacts are unchanged.

Inspection runs locally without a server:

```bash
bun run reservations inspect reserve
```

There is no schema CLI or migration planner. [Author explicit steps](../README.md#review-schema-changes), including `SqliteMigrations.copies.Expression` for stored timestamp conversions, and append reviewed artifact imports to the ordered history in [`migrations.ts`](migrations.ts). Do not regenerate previously applied artifacts from current schemas: runtime validates recorded history and exact table definitions before applying pending migrations.

## Code map

- [`domain.ts`](domain.ts): values, typed business errors, and the `held` → `confirmed`/`released` transition rule.
- [`resources.ts`](resources.ts): the two permitted generated read operations.
- [`contracts.ts`](contracts.ts): transport-independent native RPC contracts in `InventoryRpcs`.
- [`sqlite.ts`](sqlite.ts): `InventoryRpcs.toLayer` handlers, transactional guarded stock updates, transitions, and idempotent startup seed.
- [`migrations.ts`](migrations.ts) and [frozen artifacts](migrations/): ordered decoded history, including the timestamp conversion.
- [`application.ts`](application.ts): resource registration plus the native RPC group and handler layer.
- [`main.ts`](main.ts): the sole server, generated CLI, and inspection runner.
