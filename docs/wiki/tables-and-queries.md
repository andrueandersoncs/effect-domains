# Tables and Queries

## Decision

`Resource.make({ name, schema, storage?, operations, create?, list? })` is the generated persistence and routine-RPC interface. `Table.make({ name, schema })` remains the lower-level table compiler, and `Query.make({ table, Request, Result, implementation })` remains the authored request/result seam. ([Resource](../../src/resource.ts); [Table](../../src/table.ts); [Query](../../src/query.ts); [Table and query direction](raw/table-and-query-api-direction.md))

Table names are application configuration; intrinsic identity belongs to the canonical schema through `identifier`. Without one, persistence adds a generated UUIDv7 `id` to its row representation. This cleanly supersedes older interfaces without a compatibility path. ([Domain identity direction](raw/domain-identifier-and-basic-persistence-direction.md); [Clean-cutover direction](raw/refactoring-and-compatibility-direction.md))

## Canonical and Storage Representations

`schema` is the canonical application representation. `storage`, when supplied, is a reversible persistence codec whose decoded fields must exactly match the canonical schema; storage therefore may use runtime dependencies without changing RPC wire contracts. `Table.make` derives physical SQLite fields, `insertSchema`, `rowSchema`, and `storageSchema` from that storage representation. ([Resource](../../src/resource.ts); [Table](../../src/table.ts); [service-codec example](../../examples/service-codec/storage.ts))

The current compiler supports flat required string, numeric, boolean, nullable scalar, and timestamp fields. Encoded names become columns; recognized checks become SQLite constraints. Arbitrary predicates and root checks remain schema validation, and nested rows, optional keys, bare `Option`, ambiguous identity, and non-scalar storage codecs are not claimed to work. ([Table](../../src/table.ts); [SQLite DDL](../../src/sqlite-ddl.ts); [table regressions](../../test/Table.test.ts))

## Generated Resource Operations

`Resource.crud` is the existing `get`, `list`, `create`, `update`, and `remove` tuple. A resource publishes only operations named in `operations`; adding `patch` is explicit. Repositories remain available to authored code regardless of what was published. ([Resource](../../src/resource.ts); [reservation resources](../../examples/reservations/resources.ts))

Creation policy has two deliberate cases: `defaults` fills a field only when omitted, while `generated` fields are produced by the runtime `Value` service from `uuidV7` or `now` tokens and are not callable input. An implicit persistence identifier is generated in that same manner. ([Resource](../../src/resource.ts); [Value](../../src/value.ts); [resource regressions](../../test/ResourceCrud.test.ts))

A `list` declaration, for example `{ filter: ["completed"], order: [{ field: "title" }], limit: 50 }`, exposes only those exact filters and that order. The identifier is appended as a stable tie-breaker. Its response is `{ items, nextCursor }`; a cursor is bound to resource, filter, order, scalar values, and identifier. Native CLI flags support nested paths such as `--filter-completed` and `--patch-title`, alongside `--input-json`; finite numeric canonical flags are supported. ([Resource](../../src/resource.ts); [CLI](../../src/rpc-cli.ts); [resource regressions](../../test/ResourceCrud.test.ts); [CLI regressions](../../test/RpcCli.test.ts))

Patch accepts `{ identifier, patch }`, with the identifier key derived from the resource table. The identifier cannot occur in `patch`; the repository merges and validates the complete canonical value before the write, so an invalid patch leaves the stored row unchanged. ([Resource](../../src/resource.ts); [resource regressions](../../test/ResourceCrud.test.ts))

## Commands and Applications

`Commands.make(name, contracts)` turns `{ input, output, error }` contracts into an injectable service descriptor, generated RPC group, and `.layer` accepting a handler record or Effect. Captured layer dependencies serve as fallbacks, while the invocation context overrides them. `Application.make({ name, resources?, commands? })` joins descriptor and generated-resource groups and handler layers. ([Commands](../../src/commands.ts); [Application](../../src/application.ts); [command regressions](../../test/Commands.test.ts))

`ApplicationBun.run` is the sole Bun runner: it exposes generated remote operations and local `serve`, `schema`, and `inspect` commands. It builds the SQLite runtime, prepares resource tables through the migration store, builds optional services, runs optional initialization, then starts HTTP serving. ([Bun runtime](../../src/application-bun.ts))

## Authored Queries and Persisted References

`Query.make` encodes a decoded request, runs the authored Effect, and decodes the result while preserving codec services, implementation errors, and runtime requirements. This is the escape hatch for database-specific SQL and semantic behavior. ([Query](../../src/query.ts); [SQLite integration](../../test/SqliteBun.test.ts))

`PersistedRef.fromResource(resource, { key, ifMissing })` performs missing-row initialization in the repository transaction, preserves the bound key for commits, and reports a deleted row on refresh instead of recreating it. It serializes only in-process mutations; explicit refresh is not a distributed-coherence or conflict-resolution mechanism. ([PersistedRef](../../src/persisted-ref.ts); [persisted-resource regression](../../test/PersistedResource.test.ts))

## SQLite Migrations and Inspection

`SqliteMigrations.history(raw)` decodes and validates fixture history. Production startup can receive `{ migrations: decodedHistory }`, or `{ manifest: absolutePath }`, for which `SqliteMigrations.load` reads the ordered JSON artifacts. Fresh schemas are generated through `schema generate <name>` against an explicit manifest. ([Migrations](../../src/sqlite-migrations.ts); [Bun runtime](../../src/application-bun.ts))
Every runnable example resolves its own `migrations/manifest.json` to an absolute path in `main.ts` and calls `ApplicationBun.run`; static `migrations.ts` modules decode fixtures for tests, seeds, or fixture-oriented use rather than serving as production configuration. ([Todo entrypoint](../../examples/resource-crud/main.ts); [Reservation entrypoint](../../examples/reservations/main.ts); [Counter entrypoint](../../examples/persisted-ref/main.ts); [Todo fixture](../../examples/resource-crud/migrations.ts))


Migration changes needing meaning require explicit `--rename`, `--backfill`, or `--transform` intent. The generator validates its artifact before writing it and atomically replaces the manifest only after success; blocked plans report their reasons without changing the registry. Runtime applies frozen history transactionally and verifies actual schema and ledger state. ([Migrations](../../src/sqlite-migrations.ts); [migration regressions](../../test/SqliteMigrations.test.ts))

`inspect` emits canonical resource schemas, creation and list policies, canonical/storage/physical/insert/row/stored representations, and operation input/output/error schemas. Runtime service and transaction metadata are intentionally opaque metadata rather than generated UI or inferred policy. ([Inspection](../../src/application-inspect.ts); [Bun runtime](../../src/application-bun.ts))

## Evidence Boundary

Current evidence covers one SQLite adapter, the reservation slice, and five supporting applications across generated resource operations, authored queries, storage codecs, persisted resource state, and historical migration behavior. It does not establish another database, relationships, indexes, authorization, retries, idempotency, distributed coherence, or a materially different business-policy domain. ([Verification record](validation-strategy.md#2026-09-08-current-verification); [Project thesis](raw/project-thesis.md))
