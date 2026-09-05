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

## Remaining Gap

The example is unauthenticated and loopback-only. Evidence does not establish multi-process coordination, idempotent reservation creation, cancellation recovery, production deployment readiness, another database, or a materially different business domain. The next architectural evidence should test those conventions in another slice rather than expand abstractions around reservations. See the [Research Agenda](research-agenda.md).
