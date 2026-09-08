# Research Agenda

This page separates implemented behavior from evidence still needed to judge the project hypothesis. The governing constraints remain mechanical, lossless derivation and explicit business policy. ([Project thesis](raw/project-thesis.md))

## Framework Direction

The human clarified the intended product as "Rails (as in Ruby on Rails) for Effect": derive SQL table structure from domain schemas and automate routine application code. Application authors declare canonical schemas, select resource capabilities, and supply business commands and policy. The first implementation now follows that direction; one database and one business slice do not establish generality.

### Implemented contract

- `Resource.make({ name, schema, operations })` derives a table, typed repository, selected RPC contracts, and their handlers. Registration does not publish unrestricted mutations. The repository remains available to authored business handlers. ([Resource](../../src/resource.ts))
- `Table.make` derives reversible storage codecs, identity, SQL scalar types, and recognized constraints. Canonical timestamps and booleans need no second application storage model. Arbitrary predicates remain schema validation, not advertised SQL constraints. ([Table](../../src/table.ts); [SQLite DDL](../../src/sqlite-ddl.ts))
- `Application.make` accepts named, transport-independent command records of `{ input, output, error }` schemas and derives their Effect RPC definitions, JSON codecs, and group membership. `CommandService` derives decoded handler signatures from those same records. `ApplicationBun` supplies HTTP and CLI composition; `RpcCli` derives scalar field flags, validation, help, and a JSON escape hatch. ([Application](../../src/application.ts); [Reservation contracts](../../examples/reservations/contracts.ts); [Bun runtime](../../src/application-bun.ts); [CLI](../../src/rpc-cli.ts))
- The SQLite runtime provides table, repository, and schema stores over one client. Authored commands use that same client for explicit transactions. ([SQLite runtime](../../src/sqlite-bun.ts); [Reservation policy](../../examples/reservations/sqlite.ts))
- Migration planning produces immutable schema snapshots and reviewable steps. Rename, backfill, and transformation intent remain explicit; execution checks history and schema drift and applies changes transactionally. ([Migration planner and executor](../../src/sqlite-migrations.ts); [Migration regressions](../../test/SqliteMigrations.test.ts))

Publication and runtime configuration stay outside canonical schemas. Intrinsic identity is still domain metadata. Command records describe operation meaning without RPC objects; transport interpretation stays inside the application module. Shared schema contracts do not infer or merge business implementations. ([Application](../../src/application.ts); [Reservation contracts](../../examples/reservations/contracts.ts); [Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md))

## Established Persistence Findings

The compiler supports flat required rows with string, numeric, boolean, nullable scalar, and reversible timestamp representations. An explicit `identifier` supplies the primary key; otherwise the adapter generates a persistence-only UUIDv7 `id`. Multiple identifiers, optional keys, nested rows, and shapes without a scalar codec are rejected. `OptionFromNullOr` can encode a nullable scalar; a bare `Option` is not a row scalar. ([Table](../../src/table.ts); [Table tests](../../test/Table.test.ts))

Generated repositories handle ordinary persistence. `Query.make` remains the escape hatch for an authored request/result operation, preserving codec services, implementation errors, and runtime requirements. The Bun SQLite integration still exercises authored queries and query-backed persisted references. ([Query](../../src/query.ts); [SQLite integration](../../test/SqliteBun.test.ts))

`PersistedRef` loads an authoritative value, serializes local mutations, commits before publishing, preserves memory on failure, and refreshes explicitly. This is process-local synchronization, not multi-process coherence. ([PersistedRef](../../src/persisted-ref.ts); [PersistedRef tests](../../test/PersistedRef.test.ts))

## Application Evidence

The reservation slice now uses its canonical stock and reservation schemas directly. It has no duplicate storage schemas, field-copy codecs, ordinary reservation SQL, or handwritten initial DDL. SKU identity is declared in `StockSchema`. Reserve, confirm, release, stock accounting, and transaction scope remain authored. Only stock and reservation reads are published as resource operations. ([Domain](../../examples/reservations/domain.ts); [Resources](../../examples/reservations/resources.ts); [Application](../../examples/reservations/application.ts); [Policy](../../examples/reservations/sqlite.ts))

The [recorded acceptance evidence](validation-strategy.md#schema-first-acceptance-criteria) includes a fresh-database experiment where adding one integer field changed SQL, generated resource contracts, HTTP behavior, and CLI flags without adapter edits. Reservation regressions retain no-oversell, rollback, terminal-transition, and historical replay checks. Frozen migration artifacts replace the previous application-authored table creation. ([Reservation tests](../../test/Reservations.test.ts); [Migration history](../../examples/reservations/migrations.ts))

The command-contract cutover was checked through all six applications' generated CLIs and HTTP RPC endpoints, preserving CRUD results, counter refresh semantics, reservation transitions, and typed failure exits. A disposable probe exercised shared contracts, decoded handler types, JSON codecs, operation collisions, and empty applications; compilation also checked literal operation names and codec service requirements. The existing 28 regression tests passed. This is evidence for contract derivation, not new business-policy coverage. ([Application](../../src/application.ts); [Example guides](../../examples/README.md))

## Remaining Questions

Further evidence must determine:

- whether these conventions fit a materially different business domain and database;
- how relationships, joins, and multi-table query dependencies should be declared;
- how explicit storage transformations compose when a canonical value has no lossless scalar representation;
- how schema services and RPC middleware behave in a complete authenticated application;
- which additional encoded shapes earn mechanical storage or CLI support;
- whether migration planning remains readable for larger histories and database-specific changes;
- whether persisted references need optimistic versions or notifications for external writers; and
- how interruption and ambiguous database outcomes should be reconciled.

The shared `SchemaASTF` evaluator provides exhaustive traversal and explicit cycle handling. It does not imply that every schema has a lossless table representation or that all interpreters should share target semantics. ([AST evaluator](../../src/schema-ast.ts); [AST tests](../../test/SchemaAST.test.ts))

## Success and Stop Conditions

The implemented SQLite slice removes the measured mechanical duplication. The next architectural evidence must come from a materially different slice rather than more abstractions around reservations. Compare change propagation, annotation cost, escape hatches, and clarity against the [validation criteria](validation-strategy.md) before claiming a general framework. The clean-cutover policy remains in force. ([Refactoring and compatibility direction](raw/refactoring-and-compatibility-direction.md))
