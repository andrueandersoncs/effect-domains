# Persisted reference counter

This example shows a single, shared counter whose in-memory value is bound to one SQLite resource identity. It is a deliberate cache-coherence example: a process owns one `PersistedRef`, serializes its updates, and makes the boundary between its cache and the database visible.

For common runtime and schema-command conventions, see the [examples overview](../README.md). Compare the fully generated operations in [resource-crud](../resource-crud/) with this example's explicit commands.

## Run it

From the repository root, start the server:

```bash
bun run persisted-ref:server
```

The runner enables the generated admin at [http://127.0.0.1:3000/admin](http://127.0.0.1:3000/admin); its command forms call the same published RPCs. The shared [admin guide](../README.md#generated-admin) covers the optional surface and browser boundary.

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

The `counters` resource deliberately publishes **no generated operations**. [`contracts.ts`](contracts.ts) declares `counters.get`, `counters.increment`, `counters.set`, and `counters.refresh` as native RPCs and passes their `RpcGroup` to `Commands.make({ name, group })` for the injectable `CounterCommands` descriptor. [`sqlite.ts`](sqlite.ts) installs the explicit handler record with `CounterCommands.layer(...)`, using `catchTags` only to translate declared persistence-tag failures from an invocation to `CounterUnavailable`; unmatched errors are not remapped. `Application.make` combines that descriptor's RPC group with the resource group. The frozen `001_initial` artifact supplies the `counters` table, but it is not an API generator.

On startup, `PersistedRef.fromResource(CounterResource, { key: VisitsCounterId, ifMissing: { value: 0 } })` binds the ref to the `visits` identity. Within the resource transaction it loads that row or creates it once if absent; `ifMissing` supplies only non-key fields and the bound key is injected. The initial committed row becomes one process-local cache. A synchronized `increment` calculates from that cache, commits through the bound resource row, and updates the cache only from the committed result. A commit cannot change the bound identity.

## Boundaries and failure modes

- `set` intentionally bypasses the reference to demonstrate that a database write does not invalidate a cache. Use the explicit `refresh` when the caller needs the cached value to agree with storage.
- `refresh` reloads the bound `visits` row; it never recreates a row deleted after initialization. A missing row or a failed `increment`, `set`, or `refresh` is reported as `CounterUnavailable`.
- The serialization scope is one server process, not the database. Another process or direct SQLite writer can change `visits` without updating this process's cache; a later stale cached increment can overwrite that external value. This example has no distributed coherence, cross-process synchronization, or conflict detection.
- Restarting binds and loads the stored `visits` row rather than resetting it. Startup applies frozen migrations but does not reset data, and an untracked database is rejected rather than adopted.

## Code map

- [`domain.ts`](domain.ts): the `visits` identifier and counter shape.
- [`resources.ts`](resources.ts): the resource declaration with no generated operations.
- [`contracts.ts`](contracts.ts): command contracts and the `CounterCommands` descriptor.
- [`sqlite.ts`](sqlite.ts): the command layer, direct `set`, and the resource-bound cached reference.
- [`migrations/manifest.json`](migrations/manifest.json) and [frozen artifacts](migrations/): runtime migration registry and history.
- [`application.ts`](application.ts): resource and command-descriptor registration.
- [`main.ts`](main.ts): the sole server, generated CLI, schema-command, and inspection runner.
- [`../../src/persisted-ref.ts`](../../src/persisted-ref.ts): the reusable synchronized write-through reference.
