# Tables and Queries

## Decision

`Table.make({ name, schema })` derives storage from a canonical entity schema. `Resource.make({ name, schema, operations })` adds standard repository behavior and selected RPC operations. `Query.make({ table, Request, Result, implementation })` remains the explicit request/result seam for custom queries. Runtime Effect requirements identify the concrete services needed when an operation executes. ([Table](../../src/table.ts); [Resource](../../src/resource.ts); [Query](../../src/query.ts); [Table and query direction](raw/table-and-query-api-direction.md))

Table names belong to application configuration. Intrinsic identity belongs to the canonical schema through `identifier`; without it, persistence adds a generated UUIDv7 `id` to `rowSchema`. This supersedes the older requirement for exactly one domain identifier without adding a compatibility path. ([Domain identity direction](raw/domain-identifier-and-basic-persistence-direction.md); [Clean-cutover direction](raw/refactoring-and-compatibility-direction.md))

## Table Derivation

The canonical schema stays in `table.schema`. `rowSchema` includes persisted identity; `storageSchema` and `insertSchema` provide reversible row and insertion codecs. Encoded field names become columns. The compiler supports flat required fields with string, numeric, boolean, nullable scalar, and timestamp representations. Booleans store as constrained integers; canonical UTC timestamps store as ISO text. Nullable scalar codecs include `OptionFromNullOr`. Optional keys, nested rows, bare `Option`, ambiguous identity, and shapes without a scalar codec are rejected. ([Table compiler](../../src/table.ts); [Codec and rejection tests](../../test/Table.test.ts))

Recognized integer, numeric bound, length, literal-enum, and boolean checks become SQLite constraints. Arbitrary field predicates and root struct checks remain schema validation; the compiler does not claim that SQLite enforces them. The shared AST evaluator provides exhaustive traversal and explicit suspension-cycle handling. ([DDL renderer](../../src/sqlite-ddl.ts); [AST evaluator](../../src/schema-ast.ts))

## Generated Repositories

A resource supplies typed `find`, `get`, `list`, `create`, full-row `update`, and `remove` methods through `RepositoryStore`. `find` returns an Option; operations requiring a row report `ResourceNotFound` when it is missing. Storage failures use `RepositoryError`. Creation accepts the canonical value and returns the persisted row, including an adapter-generated identifier when configured. ([Repository API](../../src/resource.ts); [Store interface](../../src/repository-store.ts))

The `operations` tuple selects published RPC capabilities; it does not restrict what authored business code can do through its repository. The reservation example publishes only `stock.get` and `reservations.get`, while reserve, confirm, and release use repositories inside explicit transaction policy. ([Resources](../../examples/reservations/resources.ts); [Inventory implementation](../../examples/reservations/sqlite.ts))

## Command Contracts

Custom operations are named records of `{ input, output, error }` schemas satisfying `CommandContracts`. `Application.make({ name, resources, commands })` derives RPC definitions, JSON codecs, and group membership from those records and combines them with generated resource operations. Resource-only applications omit `commands`. `CommandService<typeof commands>` derives decoded handler signatures; implementations and transaction policy remain explicit. ([Application API](../../src/application.ts); [Reservation declarations](../../examples/reservations/contracts.ts))

Confirm and release share one contract shape but retain different implementations. The declaration does not infer operation publication or stock effects from a table or transition map. `application.commands` remains inspectable transport-independent data; `application.group` is the derived RPC representation used by HTTP and CLI interpreters. ([Reservation contracts](../../examples/reservations/contracts.ts); [Inventory policy](../../examples/reservations/sqlite.ts); [Bun runtime](../../src/application-bun.ts))

## Authored Queries

`Query.make` encodes its decoded request, runs the authored Effect with the encoded value, and decodes the result. Request encoding services, result decoding services, implementation failures, and runtime requirements remain visible in the Effect type. This supports database-specific SQL and service-dependent codecs without adding database configuration to the canonical model. ([Query](../../src/query.ts); [SQLite integration](../../test/SqliteBun.test.ts))

## Persisted References

`PersistedRef.make({ commit, load })` composes persistence operations into a shared, write-through value. It loads the authoritative value, serializes local mutations, commits before publishing, and publishes the value returned by persistence. Failure leaves memory unchanged. `refresh` reloads under the same lock. ([PersistedRef](../../src/persisted-ref.ts); [Tests](../../test/PersistedRef.test.ts))

This is a distinct type because standard Ref mutations cannot carry database failures or requirements. It does not infer row selection, upsert policy, authorization, or conflict handling. Synchronization is process-local; external writers need explicit concurrency and refresh policy. ([Project thesis](raw/project-thesis.md))

## Bun SQLite Runtime and Migrations

`SqliteBunRuntime.sqlClient` provides the database, table, repository, and schema stores over one SQLite client. Generated writes therefore participate in the same explicit transaction as authored SQL. Synthesized identifiers receive a SQLite UUIDv7 default; explicit identifiers do not. ([SQLite runtime](../../src/sqlite-bun.ts))

Fresh table creation derives from snapshots. Existing databases require reviewed migration artifacts rather than automatic destructive synchronization. `SqliteMigrations` plans additions and explicit rename, backfill, or transformation steps; unsupported or ambiguous changes remain blocked. Application startup checks the migration chain and live schema, replays frozen artifacts transactionally, and checks the resulting target. Historical artifacts do not import today's model. ([Planner and executor](../../src/sqlite-migrations.ts); [Frozen reservation history](../../examples/reservations/migrations.ts))

Migration regressions cover column-order differences after additions, whitespace inside SQL literals, explicit backfill and rename intent, and rollback of failed transformations. Reservation regressions replay historical timestamp seconds into the canonical ISO representation without resetting stock. ([Migration tests](../../test/SqliteMigrations.test.ts); [Reservation tests](../../test/Reservations.test.ts))

## Evidence Boundary

The implementation has one database adapter, a complete reservation slice, five supporting persistent applications, and a live scalar-field propagation experiment. The supporting examples exercise generated CRUD, authored queries, service-dependent codecs, process-local reference state, and historical migration through server/CLI boundaries. They do not establish portability to another database or a materially different business-policy domain. Relationships, indexes, authorization, transaction scope, retries, idempotency, and business policy remain explicit. Migration machinery can be shared; semantic migration intent cannot be inferred from a schema diff. ([Application evidence](validation-strategy.md#persistent-example-applications); [Project thesis](raw/project-thesis.md))
