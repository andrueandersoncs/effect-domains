# Research Agenda

This page distinguishes the implemented API from evidence still needed to judge the project hypothesis. Mechanical, lossless derivation remains the boundary; business policy and semantic transformations remain authored. ([Project thesis](raw/project-thesis.md))

## Framework Direction

The intended product is conventionally generated application infrastructure for Effect: authors declare canonical schemas, select generated resource capabilities, and write commands and policies whose semantics are not in those schemas. The current implementation exercises SQLite and one reservation business slice; it does not establish generality. ([Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md); [Verification limits](validation-strategy.md#evidence-boundary))

### Implemented contract

- `Resource.make({ name, schema, authorization, storage?, operations, create?, list? })` derives a storage table, policy-enforcing canonical repository, selected RPC procedures, and handlers. Authorization must explicitly select public, deny, or a typed resource policy. `storage` is a reversible representation with the same decoded fields as the canonical schema, so storage codecs do not leak onto the wire. ([Resource](../../src/resource.ts); [Authorization](../../src/authorization.ts); [resource regressions](../../test/ResourceCrud.test.ts))
- `create.defaults` fills only absent fields; `create.generated` accepts runtime `uuidV7` and `now` tokens through the `Value` service and never accepts caller overrides. `Resource.crud` is the existing five-operation tuple; `patch` is explicitly selected. ([Resource](../../src/resource.ts); [Value](../../src/value.ts))
- A declared `list` policy permits only named exact-match filters, adds a stable identifier tie-breaker to declared ordering, limits pages, and returns `{ items, nextCursor }`. Patch input is `{ identifier, patch }`, rejects identifier changes, validates the complete resulting value, and persists atomically. ([Resource](../../src/resource.ts); [resource regressions](../../test/ResourceCrud.test.ts))
- Authorization scope is mandatory and conjoined with action rules. Hidden rows look missing; SQL filters before pagination; mutations check current/candidate state and readable results transactionally. A closed policy fold drives evaluation, SQL, references, and inspection. Protected RPCs require request-local verified subjects through `Authenticator`; authored SQL remains privileged. ([Authorization contract](tables-and-queries.md#resource-authorization); [authorization regressions](../../test/Authorization.test.ts); [RPC identity regressions](../../test/AuthorizationRpc.test.ts))
- `Commands.make({ name, group })` accepts a native Effect `RpcGroup` and produces an injectable `Context.Service` descriptor and `.layer(record | Effect)` for unary handlers. `Commands.rpc(tag, { payload, success, error })` derives JSON codecs from explicit schemas and returns a native RPC; direct `Rpc.make` remains the escape hatch. The group is retained unchanged, with no separate command-contract format. The layer captures fallback dependencies while invocation context takes precedence. `Application.make({ name, resources, commands })` merges resource and command handlers and detects duplicate unary operation names; empty arrays represent absent groups. `Application.prepare(application)` prepares resource tables. ([Commands](../../src/commands.ts); [Book RPCs](../../examples/authored-sql/contracts.ts); [Application](../../src/application.ts); [Command regressions](../../test/Commands.test.ts))
- `ApplicationBun.run(application, { database, services, initialize })` is the single Bun entrypoint. Database options contain either `manifest` or `migrations`, plus an `Option` filename; `Option.none()` selects environment/default configuration. `Layer.empty` and `Effect.void` express absent services and initialization. Startup orders database runtime, application preparation, services, initialization, and HTTP launch; the same runner derives remote commands and local `serve`, `schema`, and `inspect`. ([Bun runtime](../../src/application-bun.ts); [CLI](../../src/rpc-cli.ts))
- `SqliteMigrations.decodeHistory(raw)` decodes and validates fixture history as an Effect; `SqliteMigrations.load(manifest)` reads the ordered artifact manifest. Direct `SqliteMigrations.command` options use `Option` for history and manifest. Every nonempty managed schema requires an initial migration, and the applied-artifact ledger is the sole migration state. `schema generate <name>` validates explicit `--rename`, `--backfill`, or `--transform` intent, writes a new artifact, then atomically replaces the manifest. A blocked or invalid plan leaves the registry unchanged. ([Migrations](../../src/sqlite-migrations.ts); [migration regressions](../../test/SqliteMigrations.test.ts))
- `inspect` emits generated operation input/output/error schemas and resource canonical schema, creation/list policy, storage schema, physical table, insert schema, row schema, and stored schema. It represents opaque services and transaction metadata only as opaque runtime requirements; it does not generate a UI. ([Inspection](../../src/application-inspect.ts); [Bun runtime](../../src/application-bun.ts))

Publication and runtime configuration remain outside canonical schemas. Intrinsic identity is domain metadata; generated persistence identity is an adapter concern. Native RPC declarations belong to the operation-contract layer and do not select HTTP transport; application declarations register their service descriptors. The 2026-09-08 user-approved native-RPC cutover supersedes the separate command-contract representation rather than preserving an alias. ([Domain identifier direction](raw/domain-identifier-and-basic-persistence-direction.md); [Commands](../../src/commands.ts); [Bun runtime](../../src/application-bun.ts))

## Established Persistence Findings

`Table.make` compiles supported flat canonical fields to reversible storage codecs and SQLite fields. An explicit `identifier` remains the key; otherwise persistence adds UUIDv7 `id` to the row representation. The compiler supports string, numeric, boolean, nullable scalar, and timestamp representations, not arbitrary nested or optional-key models. ([Table](../../src/table.ts); [table regressions](../../test/Table.test.ts))

Generated repositories handle routine persistence; authored operations use native Effect `SqlSchema` and `SqlClient`, or explicit schema conversions. The framework `Query` descriptor is removed. `PersistedRef.fromResource(resource, { key, ifMissing })` atomically finds or initializes one resource row, binds future commits to that key, and does not recreate a later-deleted row on refresh. It is local synchronization, not distributed cache coherence. ([Authored SQL](../../examples/authored-sql/sqlite.ts); [PersistedRef](../../src/persisted-ref.ts); [Persisted-resource regression](../../test/PersistedResource.test.ts))

## Application Evidence

The reservation application uses canonical stock and reservation schemas with generated reads and explicit transactional reserve, confirm, release, accounting, and transition policy. Six supporting applications exercise minimal generated book CRUD, configured todo CRUD, authored book queries, service-dependent storage codecs, resource-bound state, and a historical document migration. Basic CRUD and authored SQL share the canonical book schema; custom errors and remove results remain in the authored example. These are integration demonstrations, not a second materially different business-policy slice. ([Basic resource](../../examples/basic-crud/resources.ts); [Authored contracts](../../examples/authored-sql/contracts.ts); [Reservation policy](../../examples/reservations/sqlite.ts); [Example guide](../../examples/README.md))

Two supporting applications now expose distinct authored authorization policies without new framework machinery: tenant-owned todos restrict edits by current completion state and preserve ownership; global shared notes use role membership while retaining their semantic storage codec. A shared example authenticator resolves deliberately public bearer sessions to server-owned claims. This is runnable policy evidence, not a production identity system or a second materially different business-policy slice. ([Todo rules](../../examples/resource-crud/resources.ts); [Note rules](../../examples/service-codec/resources.ts); [Demo identities](../../examples/authentication.ts))

The dated [authorized-example verification](validation-strategy.md#2026-09-09-authorized-examples) records current live policy, codec, and migration/restart evidence. [Authorization verification](validation-strategy.md#2026-09-08-resource-authorization) records the core identity-isolation, SQL parity, and type boundaries; earlier records remain historical evidence for their exercised interfaces.

## Remaining Questions

Further evidence must determine:

- whether the conventions fit another database and a materially different business domain;
- how relationships, joins, and multi-table query dependencies should be declared;
- how explicit storage transformations compose where a canonical value has no lossless scalar representation;
- how verified identity issuance, revocation, and authored multi-resource commands compose with authorization in a production application;
- which encoded shapes earn mechanical storage or CLI support;
- whether migration planning remains readable for larger histories and database-specific changes;
- whether persisted references need versions or notifications for external writers; and
- how interruption and ambiguous database outcomes should be reconciled.

The table compiler directly interprets supported Effect AST nodes and rejects cyclic suspended scalar fields. Its storage semantics remain separate from CLI flag interpretation; neither implies arbitrary schemas have lossless table representations. ([Table compiler](../../src/table.ts); [table regressions](../../test/Table.test.ts); [CLI](../../src/rpc-cli.ts))

## Success and Stop Conditions

The SQLite implementation removes exercised mechanical duplication. The next architectural evidence must be a materially different slice, not more abstraction around reservations. Compare propagation, annotation cost, escape hatches, and clarity against the [validation criteria](validation-strategy.md) before claiming a general framework. ([Refactoring direction](raw/refactoring-and-compatibility-direction.md))
