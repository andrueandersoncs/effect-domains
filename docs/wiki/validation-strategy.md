# Validation Strategy

## Goal

Treat Effect Domains as a design hypothesis to test through narrow vertical slices. Each slice should be complete enough to expose semantic differences between the domain, behavior, storage, and transport instead of demonstrating schema syntax alone. ([Project thesis](raw/project-thesis.md))

## Required Shape of a Slice

Each experiment should include:

1. branded domain values;
2. an entity with a meaningful state transition;
3. a business operation with typed domain errors;
4. a database representation;
5. a versioned wire representation;
6. explicit transformations wherever representations differ; and
7. a historical database migration.

These elements are required by the source thesis because they test both derivable structure and concerns that must remain authored. ([Project thesis](raw/project-thesis.md))

## Evaluation Questions

For every slice, record:

- How much duplicate declaration disappeared?
- Did domain changes propagate safely?
- How much annotation machinery was required?
- Did the normal user path remain declarative, without requiring authored functions or procedures?
- Did Effect requirements keep concrete infrastructure replaceable behind a narrow interface?
- Were escape hatches straightforward?
- Is the result easier to understand than handwritten adapters?

Compare evidence across materially different domains before extracting a general algebra. One successful slice can validate a technique, but it cannot establish that the technique generalizes. ([Project thesis](raw/project-thesis.md)) The interface and implementation questions reflect the later project-wide direction toward declarative APIs and Effect requirements. ([Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md))

## Evidence Standard

An experiment page should link to its implementation and tests, state what was authored versus derived, and answer each evaluation question. It should also report failures and awkward cases rather than presenting only the successful path. This reporting format is **wiki analysis** derived from the thesis’s evaluation criteria; it is not an additional claim from the source.

## Reservation Slice

The [reservation application](../../examples/README.md#reservation-application) supplies the first executable application experiment. Its [domain](../../examples/reservations/domain.ts) has branded SKU and reservation identifiers, positive quantities, and an explicit `held → confirmed | released` transition table. [RPC contracts](../../examples/reservations/contracts.ts) describe requests, successes, and typed failures independently of the database.

### Authored and derived

| Concern | Implementation |
| --- | --- |
| Operation contracts | Authored once with Effect `Rpc.make` and `RpcGroup.make` |
| HTTP dispatch and codecs | Effect's RPC server interprets the group |
| CLI commands and codecs | [`RpcCli.make`](../../src/rpc-cli.ts) interprets the same group |
| Policies and transactions | Explicit [`Inventory`](../../examples/reservations/inventory.ts) implementation in [`sqlite.ts`](../../examples/reservations/sqlite.ts) |
| Representations | Domain `DateTime.Utc`, storage `created_at_ms`, wire v1 ISO `createdAt`; conversion is explicit |
| Migration history | [`001_initial` and `002_milliseconds`](../../examples/reservations/migrations.ts), applied by Effect's SQLite migrator |

The [regression scenarios](../../test/Reservations.test.ts) cover competing reservations for the last item, rollback when reservation insertion fails, terminal transitions that cannot restore stock twice, and migration of historical reservations without resetting stock. The [CLI regression](../../test/RpcCli.test.ts) exercises the real executable's failure exit and separate output streams.

### Evaluation

- **Duplicate declarations:** five CLI commands are generated without per-operation parsers or dispatch handlers. HTTP uses the same RPC definitions, but storage schemas, initial DDL, row mappings, and ordinary queries remain handwritten. The slice does not meet the intended framework automation level. No handwritten-adapter baseline or total line-count saving has been measured.
- **Change propagation:** a live experiment changed a shared request field from optional to required. Both HTTP and CLI rejected the old payload and accepted the new one without adapter edits. This proves that contract change, not arbitrary schema evolution.
- **Annotation cost:** stock identity is declared only in the storage schema rather than the canonical stock schema. There are no HTTP or CLI annotations on the canonical reservation model.
- **Declarative user path:** operation contracts and transitions are data. Handler binding, transaction boundaries, stock policy, and migrations are authored Effects.
- **Infrastructure boundary:** the domain-facing `Inventory` service has no SQLite dependency. Only one concrete database implementation has been exercised.
- **Escape hatches:** existing `Query.make` operations and direct transactional SQL compose without changing the RPC or CLI contracts.
- **Clarity judgment:** reusing Effect's RPC contracts avoids a competing operation framework. JSON payloads avoid inventing field-to-flag policies, at the cost of a less ergonomic CLI than individually designed flags.

Live verification also exercised cross-interface reserve/release/confirm calls, typed failures, timestamp encoding, concurrent HTTP requests, and restart persistence. The example is unauthenticated and loopback-only. Evidence does not establish multi-process coordination, idempotent reservation creation, cancellation recovery, or production deployment readiness.

## Schema-First Acceptance Criteria

The next proof should meet the [clarified framework direction](research-agenda.md#framework-direction):

1. Derive fresh SQL tables from the canonical stock and reservation schemas, including their identity and supported numeric and enum constraints. Do not author duplicate storage fields or initial DDL.
2. Round-trip canonical timestamps through persistence and transport without application-authored field-copy functions.
3. Supply ordinary repository operations and enabled resource contracts by convention. Keep reserve, confirm, release, and their transaction scope explicitly authored.
4. Add a normal scalar field in one canonical schema. On a fresh database, persistence, resource input/output contracts, and HTTP/CLI validation must follow without per-layer field edits.
5. Preserve no-oversell, rollback, and terminal-transition guarantees. Generated resource exposure must not let callers bypass those policies with unrestricted reservation updates.
6. Produce reviewable schema changes for existing databases. Historical migration replay must not change when the current model changes; renames and backfills require explicit intent.

## Remaining Gap

First remove the measured mechanical duplication from the reservation slice. Then test the conventions against a materially different domain and another infrastructure implementation before claiming generality. See the [Research Agenda](research-agenda.md).
