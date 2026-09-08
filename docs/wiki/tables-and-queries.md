# Tables and Queries

## Decision

`Resource.make({ name, schema, storage?, operations, create?, list? })` is the generated persistence and routine-RPC interface. `Table.make({ name, schema })` is the lower-level compiler. Authored SQL uses Effect `SqlSchema` and native `SqlClient`; other authored Effects use explicit schema conversions where needed. The 2026-09-08 user-approved simplification removes the earlier `Query.make` descriptor rather than preserving a compatibility wrapper. ([Resource](../../src/resource.ts); [Table](../../src/table.ts); [Authored SQL](../../examples/basic-crud/sqlite.ts); [superseded query direction](raw/table-and-query-api-direction.md))

Table names are application configuration; intrinsic identity belongs to the canonical schema through `identifier`. Without one, persistence adds a generated UUIDv7 `id` to its row representation. This cleanly supersedes older interfaces without a compatibility path. ([Domain identity direction](raw/domain-identifier-and-basic-persistence-direction.md); [Clean-cutover direction](raw/refactoring-and-compatibility-direction.md))

## Canonical and Storage Representations

`schema` is the canonical application representation. `storage`, when supplied, is a reversible persistence codec whose decoded fields must exactly match the canonical schema; storage therefore may use runtime dependencies without changing RPC wire contracts. `Table.make` derives physical SQLite fields, `insertSchema`, `rowSchema`, and `storageSchema` from that storage representation. ([Resource](../../src/resource.ts); [Table](../../src/table.ts); [service-codec example](../../examples/service-codec/storage.ts))

Table fields are compiled once and reused for physical metadata and codecs. `Table`, `Resource`, and `Application` are typed runtime descriptors, not `Schema.Class` values with opaque fields; persisted snapshots remain real schemas. Table and CLI interpreters traverse the Effect AST directly with target-specific semantics. ([Table compiler](../../src/table.ts); [CLI](../../src/rpc-cli.ts); [Application](../../src/application.ts))

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

Effect `SqlSchema.findOne`, `findOneOption`, and `findAll` encode requests and decode SQL results while retaining codec-service dependencies. Authored effects use the same native `SqlClient` supplied to generated repositories, so their transaction boundaries compose. Explicit schema encode/decode remains available when upstream SQL cardinality semantics do not fit. ([Authored book queries](../../examples/basic-crud/sqlite.ts); [SQLite integration](../../test/SqliteBun.test.ts); [runtime](../../src/sqlite-bun.ts))

`PersistedRef.fromResource(resource, { key, ifMissing })` performs missing-row initialization in the repository transaction, preserves the bound key for commits, and reports a deleted row on refresh instead of recreating it. It serializes only in-process mutations; explicit refresh is not a distributed-coherence or conflict-resolution mechanism. ([PersistedRef](../../src/persisted-ref.ts); [persisted-resource regression](../../test/PersistedResource.test.ts))

## SQLite Migrations and Inspection

`SqliteMigrations.history(raw)` decodes and validates fixture history. Production startup can receive `{ migrations: decodedHistory }`, or `{ manifest: absolutePath }`, for which `SqliteMigrations.load` reads the ordered JSON artifacts. Fresh schemas are generated through `schema generate <name>` against an explicit manifest. ([Migrations](../../src/sqlite-migrations.ts); [Bun runtime](../../src/application-bun.ts))
Every runnable example resolves its own manifest to an absolute path in `main.ts` and calls `ApplicationBun.run`. Static history modules remain only for the reservation regression and historical document seed; unused duplicate registries are removed. ([Reservation fixture](../../examples/reservations/migrations.ts); [Document seed](../../examples/migration-lifecycle/seed-v1.ts))


Migration changes needing meaning require explicit `--rename`, `--backfill`, or `--transform` intent. The generator validates its artifact before writing it and atomically replaces the manifest only after success; blocked plans leave the registry unchanged. Every nonempty managed schema requires an initial migration. There is no direct table-write service, artifact-free bootstrap, or later adoption path: the applied-artifact ledger determines expected state. Runtime verifies actual schema and ledger contents and applies pending migrations transactionally. Empty schemas may use empty history. ([Migrations](../../src/sqlite-migrations.ts); [migration regressions](../../test/SqliteMigrations.test.ts))

`inspect` emits canonical resource schemas, creation and list policies, canonical/storage/physical/insert/row/stored representations, and operation input/output/error schemas. Runtime service and transaction metadata are intentionally opaque metadata rather than generated UI or inferred policy. ([Inspection](../../src/application-inspect.ts); [Bun runtime](../../src/application-bun.ts))

## Evidence Boundary

Current evidence covers one SQLite adapter, the reservation slice, and five supporting applications across generated resource operations, authored queries, storage codecs, persisted resource state, and historical migration behavior. It does not establish another database, relationships, indexes, authorization, retries, idempotency, distributed coherence, or a materially different business-policy domain. ([Verification record](validation-strategy.md#2026-09-08-simplification-verification); [Project thesis](raw/project-thesis.md))
