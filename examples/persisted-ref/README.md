# Persisted reference counter

This example shows a single, shared counter whose in-memory value is backed by SQLite. It is a deliberate cache-coherence example: a process owns one `PersistedRef`, serializes its updates, and makes the boundary between its cache and the database visible.

For common runtime and schema-command conventions, see the [examples overview](../README.md). Compare the fully generated operations in [resource-crud](../resource-crud/) with this example's explicit commands.

## Run it

From the repository root, start the server:

```bash
bun run persisted-ref:server
```

In another terminal, exercise the cached and stored paths:

```bash
bun run persisted-ref counters.get
bun run persisted-ref counters.increment
bun run persisted-ref counters.set --input-json '{"value":100}'
bun run persisted-ref counters.get
bun run persisted-ref counters.refresh
```

`counters.increment` returns the incremented, persisted counter. `counters.set` writes the `visits` row directly, so the following `get` still returns the old cached value; `counters.refresh` reloads SQLite and returns the counter with `value: 100`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `PERSISTED_REF_DB` | `persisted-ref.sqlite` | SQLite database used by the server |
| `PORT` | `3000` | Loopback HTTP port |
| `PERSISTED_REF_URL` | `http://127.0.0.1:3000/rpc/v1` | RPC endpoint used by the CLI |

For example, use a separate database and matching endpoint when another example uses the default port:

```bash
PORT=3001 PERSISTED_REF_DB=counter.sqlite bun run persisted-ref:server
PERSISTED_REF_URL=http://127.0.0.1:3001/rpc/v1 bun run persisted-ref counters.get
```

The server is loopback-only and unauthenticated, using Effect's JSON RPC protocol rather than REST.

## What is generated and what is authored

The `counters` resource deliberately publishes **no generated operations**. [`contracts.ts`](contracts.ts) declares `counters.get`, `counters.increment`, `counters.set`, and `counters.refresh` as named `{ input, output, error }` schemas. Get, increment, and refresh share one contract shape but retain distinct authored implementations. `Application.make` derives the RPCs and group, and `CommandService` derives the service signatures. The frozen `001_initial` artifact supplies the `counters` table, but it is not an API generator.

On startup, the application prepares the migration history, creates the singleton `visits` row with value `0` only if it is absent, and loads that row into one process-local `PersistedRef`. A `PersistedRef` update is synchronized: `increment` calculates from the cached value, writes the resulting row through to SQLite, and updates the cache only from the committed result.

## Boundaries and failure modes

- `set` intentionally bypasses the reference to demonstrate that a database write does not invalidate a cache. Use `refresh` after it when the caller needs the cached value to agree with storage.
- The serialization scope is one server process, not the database. Another process or direct SQLite writer can change `visits` without updating this process's cache; a later stale cached increment can overwrite that external value. This example has no cross-process synchronization or conflict detection.
- Restarting reloads the stored `visits` value rather than resetting it. Startup applies frozen migrations but does not reset data, and an untracked database is rejected rather than adopted.
- `increment`, `set`, and `refresh` map failed persistence or a missing `visits` row to `CounterUnavailable`; the initial load has the same typed failure. A later `get` reads only the already-loaded cache.

## Code map

- [`domain.ts`](domain.ts): the `visits` identifier and counter shape.
- [`resources.ts`](resources.ts): the resource declaration with no generated operations.
- [`contracts.ts`](contracts.ts) and [`counter.ts`](counter.ts): command declarations and their derived service/error contract.
- [`sqlite.ts`](sqlite.ts): startup seed, authored queries, direct `set`, and the cached reference.
- [`migrations.ts`](migrations.ts) and [the frozen artifact](migrations/001_initial.json): database history.
- [`application.ts`](application.ts), [`server.ts`](server.ts), and [`cli.ts`](cli.ts): registration, runtime configuration, and CLI entry point.
- [`../../src/persisted-ref.ts`](../../src/persisted-ref.ts): the reusable synchronized write-through reference.
