# Validation Strategy

## Goal

Test Effect Domains through complete vertical slices that expose the difference between domain behavior, storage, and transport. A schema demonstration alone cannot establish useful conventions. ([Project thesis](raw/project-thesis.md))

## Required Shape of a Slice

Each materially different slice should include branded values, a meaningful transition, typed business failures, database and wire representations, explicit transformations where semantics differ, and historical migration. Record removed duplication, change propagation, annotation cost, runtime boundaries, escape hatches, and clarity against handwritten adapters. ([Project thesis](raw/project-thesis.md); [Declarative interface direction](raw/effect-and-declarative-interface-direction.md))

## Evidence Standard

Link implementation and regressions, distinguish authored policy from generated machinery, and date live observations. A successful scenario establishes only its exercised contract. Historical verification is retained as historical evidence when the interface changes. This reporting rule is wiki analysis based on the thesis evaluation criteria.

## Reservation Slice

The [reservation application](../../examples/reservations/README.md) has branded SKU and reservation identifiers, positive quantities, and explicit `held → confirmed | released` transitions. Canonical models contain no transport or persistence mapping annotations beyond intrinsic identity. ([Domain](../../examples/reservations/domain.ts))

| Concern | Implementation |
| --- | --- |
| Models and policy | Canonical schemas, reserve/confirm/release contracts, transitions, guarded stock accounting, and transactions are authored |
| Storage | Resource tables, recognized constraints, and reversible codecs are generated |
| Publication | Only selected resource reads are published; reservation mutations remain business commands |
| HTTP and CLI | Application groups provide RPC dispatch, native flags, validation, help, and JSON fallback |
| History | Frozen artifacts preserve historical schema and explicit timestamp conversion |

Sources: [resources](../../examples/reservations/resources.ts), [application](../../examples/reservations/application.ts), [contracts](../../examples/reservations/contracts.ts), [policy](../../examples/reservations/sqlite.ts), [migration fixture](../../examples/reservations/migrations.ts), and [runtime](../../src/application-bun.ts).

The slice removes duplicate storage schemas, ordinary read/query plumbing, initial DDL, and per-operation HTTP/CLI binding; stock effects and transaction boundaries remain authored. It is an SQLite-only result, and native flags are not evidence that generated CLIs replace domain-specific CLI design. ([Reservation regressions](../../test/Reservations.test.ts); [CLI regressions](../../test/RpcCli.test.ts))

## Verification Record

### 2026-09-08: Current verification

The following was exercised against the current descriptor, resource, manifest, and single-runner APIs:

- All six applications ran through their actual CLI/server surfaces. Todo creation defaulted `completed` to `false`; patching nested resource input succeeded; generated identifier override was rejected; filtered listing selected completed rows; separate cursor traversal covered four rows, including equal titles, without duplicate identifiers; and restart retained data. A deterministic runtime `Value` service supplied an explicit generated identifier and timestamp, while caller overrides were rejected. ([Todo resource](../../examples/resource-crud/resources.ts); [Todo entrypoint](../../examples/resource-crud/main.ts); [Value](../../src/value.ts); [resource regressions](../../test/ResourceCrud.test.ts))
- The notes application returned canonical plain text over RPC while SQLite stored its `stored:` form. The persisted counter accepted eight simultaneous increments, retained process-local cache after a direct write, then loaded the direct value through refresh and restart. This exercises local synchronization only. ([Note storage](../../examples/service-codec/storage.ts); [Counter implementation](../../examples/persisted-ref/sqlite.ts); [persisted-resource regression](../../test/PersistedResource.test.ts))
- Reservation reserve/release succeeded; confirming a released reservation returned `InvalidReservationState` with nonzero stderr. The authored book application created, read, and listed rows through SQL. ([Reservation policy](../../examples/reservations/sqlite.ts); [Book SQL](../../examples/basic-crud/sqlite.ts))
- The historical document application preserved existing identifier and title while upgrading it to `heading`, retained nullable `summary`, and backfilled `priority: 0`. A real migration runner generated an initial manifest artifact, preserved an existing row, rejected a required `priority` change with its exact blocked reason and no registry change, then generated `--backfill documents:priority:7`; the next server loaded that manifest and preserved the original identifier/title with priority `7`. The ledger contained `001_initial` and `002_priority`. ([Document entrypoint](../../examples/migration-lifecycle/main.ts); [migration fixture](../../examples/migration-lifecycle/migrations.ts); [migration regressions](../../test/SqliteMigrations.test.ts))
- `inspect todos.create` worked with an invalid remote URL because inspection is local; an unknown operation failed. Inspection includes generated schemas and resource/storage policy rather than a generated interface. ([Inspection](../../src/application-inspect.ts); [Bun runtime](../../src/application-bun.ts))
- `bun run check` passed, and all 33 tests in 11 test files passed. An earlier `better-typescript@0.4.12` lint attempt crashed with `SIGSEGV` in `inflight_dedupe_map.markGetOrStart`; the final attempt completed with exit code 1 and 772 diagnostics across 30 files. Leading categories were nested-call restrictions, declaration spacing, Effect collection conventions, and optional-property restrictions. Lint is not counted as passing verification; no rules were disabled.

This is evidence for the listed SQLite/application paths. It does not validate another database adapter or a second materially different business-policy slice.

### Historical verification (pre-2026-09-08 API)

Earlier evidence recorded a fresh-database scalar-field propagation experiment, 28 passing repository tests, five supporting persistent applications, and ten concurrent counter increments. It covered older command-record/application composition and historical example entrypoints; retain it as historical context, not a claim about the current `Commands` descriptors, manifest loading, or `ApplicationBun.run` contract.

That historical work observed generated todo CRUD, authored book queries, service-dependent note codecs, persisted counter refresh, and historical document rename/backfill. It also exercised reservation no-oversell, rollback, terminal transitions, and timestamp replay. The linked sources remain useful for the underlying behavior: [reservation regressions](../../test/Reservations.test.ts), [table regressions](../../test/Table.test.ts), [SQLite migration regressions](../../test/SqliteMigrations.test.ts), and [example guide](../../examples/README.md).

## Evidence Boundary

The examples are unauthenticated and loopback-only. Evidence does not establish multi-process coordination, idempotent reservation creation, cancellation recovery, production deployment readiness, another database, relationships, or a materially different business domain. In particular, an external write can supersede a persisted reference unless the application defines a concurrency policy; refresh alone is not one. ([PersistedRef](../../src/persisted-ref.ts); [Research agenda](research-agenda.md))

The next architectural evidence should be another material slice rather than further generalization around the reservation application.
