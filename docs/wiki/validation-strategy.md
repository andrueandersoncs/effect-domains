# Validation Strategy

## Goal

Test Effect Domains through complete vertical slices that expose differences between domain behavior, storage, and transport. A schema demonstration alone cannot establish useful application conventions. ([Project thesis](raw/project-thesis.md))

## Required Shape of a Slice

Each slice should include branded values, a meaningful state transition, a business operation with typed errors, database and versioned wire representations, explicit transformations where semantics differ, and a historical migration. These test both derivable structure and authored policy. ([Project thesis](raw/project-thesis.md))

Record how much duplication disappears, whether changes propagate safely, annotation cost, whether the normal interface stays declarative, runtime service boundaries, escape hatches, and clarity compared with handwritten adapters. Compare materially different domains before claiming generality. ([Project thesis](raw/project-thesis.md); [Declarative interface direction](raw/effect-and-declarative-interface-direction.md))

## Evidence Standard

Link implementation and regressions, distinguish authored policy from derived machinery, and record failures and limits. A live experiment is evidence for the exercised scenario, not a promise that all schema evolution works. This reporting standard is wiki analysis derived from the thesis's evaluation criteria.

## Reservation Slice

The [reservation application](../../examples/README.md#reservation-application) has branded SKU and reservation identifiers, positive quantities, and an explicit `held → confirmed | released` transition table. Canonical models have no transport or persistence field annotations beyond intrinsic identity. ([Domain](../../examples/reservations/domain.ts))

### Authored and derived

| Concern | Implementation |
| --- | --- |
| Models and policy | Canonical schemas, reserve/confirm/release contracts, transition table, guarded stock accounting, and transactions are authored |
| Storage | Tables, recognized constraints, reversible codecs, and ordinary repository operations derive from resources |
| Resource publication | Only `stock.get` and `reservations.get` are enabled |
| HTTP and CLI | The combined Effect RPC group supplies HTTP dispatch, native scalar flags, help, validation, and JSON fallback |
| Timestamps | Framework codecs round-trip canonical UTC values through ISO storage and JSON without application row-copy functions |
| History | Frozen `001_initial` and `002_timestamp` artifacts preserve historical schema and convert timestamp seconds explicitly |

Sources: [resources](../../examples/reservations/resources.ts), [application](../../examples/reservations/application.ts), [command contracts](../../examples/reservations/contracts.ts), [business implementation](../../examples/reservations/sqlite.ts), [migration history](../../examples/reservations/migrations.ts), [runtime](../../src/application-bun.ts).

### Evaluation

- Duplicate storage schemas, ordinary reservation queries, row mappings, initial DDL, and per-operation HTTP/CLI bindings are removed. Business command inputs and policy remain explicit. No total line-count saving or handwritten-adapter baseline has been measured.
- SKU identity is declared in the canonical stock schema. Timestamps no longer need an application-specific storage representation.
- Resource capabilities and command contracts are declarative. Stock effects and transaction boundaries remain authored Effects over the same runtime client.
- The `Inventory` service is independent of SQLite. Only one concrete database implementation has been exercised.
- Authored queries and direct transactional SQL remain escape hatches. Generated resource mutations are not published for reservations.
- Native flags improve the ordinary scalar path; nullable and structured payloads can use JSON. No claim is made that generated flags replace domain-specific CLI design.

The [reservation regressions](../../test/Reservations.test.ts) cover competing reservations for the last item, rollback on failed insertion, terminal transitions that cannot restore stock twice, and historical replay without resetting stock. The [CLI regression](../../test/RpcCli.test.ts) launches the executable and verifies validation failure on stderr with clean JSON stdout.

## Schema-First Acceptance Criteria

The implemented proof covers the [framework direction](research-agenda.md#framework-direction):

1. Canonical stock and reservation schemas derive SQL tables, identity, supported numeric and enum constraints, and initial migration artifacts. There is no duplicate storage model or handwritten initial DDL.
2. Native UTC timestamps round-trip through generated storage and JSON codecs without application field-copy functions. Codec regressions also cover booleans, nullable scalar codecs, and preserved root checks. ([Table tests](../../test/Table.test.ts))
3. Resources supply typed repositories and selected RPC operations. Reserve, confirm, release, and their transaction scope stay explicit.
4. A live fresh-database experiment added `priority: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))` to one canonical schema while leaving application, HTTP server, and CLI definitions unchanged. SQLite gained the column and constraint; generated CLI help gained `--priority`; create/get/list/update/remove traversed HTTP and SQLite. Negative values were rejected, `false` remained false, and timestamp milliseconds survived. The throwaway experiment was removed after verification; its outcome is recorded here rather than retained as a second application.
5. Reservation regression scenarios preserve no-oversell, rollback, and terminal-state guarantees. Live verification also attempted an unpublished reservation update over RPC and confirmed rejection without changing the reservation.
6. Existing databases use reviewed artifacts. Migration regressions cover explicit rename/backfill intent, literal-aware drift checks, column-order differences after additions, and rollback of failed transformations. Historical reservation replay uses frozen files independent of the current model. ([Migration regressions](../../test/SqliteMigrations.test.ts))

## Persistent Example Applications

The five focused demonstrations now run as persistent applications alongside reservations. Each has a registered application, HTTP server, generated CLI, local schema commands, and frozen SQLite migration history. The [application guide](../../examples/README.md#choose-an-application) documents commands and configuration. These are supporting integration examples, not five additional business-policy vertical slices.

Live CLI verification exercised:

- **Authored book queries:** create, get, list, full-row update, removal, missing-record failures, and row preservation across a server restart. The query implementation remains explicit SQL rather than generated repository behavior. ([Implementation](../../examples/basic-crud/sqlite.ts))
- **Generated todo CRUD:** all five published resource operations, explicit false booleans, invalid-title rejection, and persistence across restart. The application has no authored business service. ([Resource](../../examples/resource-crud/resources.ts); [Runtime](../../examples/resource-crud/server.ts))
- **Service-dependent note codecs:** CRUD and restart preserved canonical text over RPC while SQLite stored the `stored:` prefix. The runtime supplies the storage codec's service; public contracts use the separate canonical note schema. Duplicate creation and missing-record operations returned typed failures. ([Storage codec](../../examples/service-codec/storage.ts); [Contracts](../../examples/service-codec/contracts.ts); [Implementation](../../examples/service-codec/sqlite.ts))
- **Persisted counter:** ten concurrent CLI increments produced values 1–10. A direct stored write to 100 left the shared reference at 10; explicit refresh and subsequent server restart both loaded 100. The seed creates `visits` only when absent. ([Implementation](../../examples/persisted-ref/sqlite.ts))
- **Versioned documents:** running the historical seed twice produced one row. Starting the current server preserved that row's identifier and title value as `heading`, added nullable `summary`, and backfilled `priority: 0`. A later edit survived restart; replaying the legacy seed against the upgraded database was rejected without changing the row. An unresolved CLI plan exited nonzero; explicit rename/backfill intent reproduced the frozen reviewed artifact. A fresh database also applied both migrations without historical seeding. ([Legacy seed](../../examples/migration-lifecycle/seed-v1.ts); [History](../../examples/migration-lifecycle/migrations.ts); [Reviewed artifact](../../examples/migration-lifecycle/migrations/002_document_metadata.json))

The supporting runtime scenarios used disposable verification databases, not the applications' default persistent files. All five application help and snapshot commands ran locally; typechecking, example-scoped lint, and the 28 repository tests passed. The reservation reserve/release path was also exercised through the shared runtime after the application-composition typing changes.

The examples do not add authentication, multi-process cache coherence, or another database adapter. In particular, a stale persisted-counter write can overwrite an external change; explicit refresh is not a concurrency-control policy.

## Remaining Gap

The example is unauthenticated and loopback-only. Evidence does not establish multi-process coordination, idempotent reservation creation, cancellation recovery, production deployment readiness, another database, or a materially different business domain. The next architectural evidence should test those conventions in another slice rather than expand abstractions around reservations. See the [Research Agenda](research-agenda.md).
