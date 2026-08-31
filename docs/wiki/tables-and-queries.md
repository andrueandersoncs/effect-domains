# Tables and Queries

## Decision

Persistence uses two composable definitions. `Table.make(schema, { name })` derives a table from a canonical entity schema. `Query.make(table, config)` defines exactly one executable operation from `Request` and `Result` schemas plus an authored Effect implementation. Query config has no operation discriminator and no database field. The implementation’s Effect requirements identify the database service only when the query executes. This cleanly supersedes the earlier `Persistence.define` catalog interface rather than preserving a compatibility path. ([Table and query API direction](raw/table-and-query-api-direction.md); [Refactoring and compatibility direction](raw/refactoring-and-compatibility-direction.md))

The earlier catalog direction used one catalog key as both capability and SQL table name. The newer direction moves table identity into the explicit `Table.make` config and removes the capability catalog. Current table derivation also makes `Domain.identifier` optional: a schema without one receives a persistence-only UUIDv7 `id`, while one annotated field overrides that default. This current behavior supersedes the older raw-source requirement that every canonical schema declare exactly one identifier. Encoded field names still become database columns, and fresh table creation remains derived while migrations remain explicit. ([Table implementation](../../src/Table.ts); [Table and query API direction](raw/table-and-query-api-direction.md); [Domain identifier and basic persistence direction](raw/domain-identifier-and-basic-persistence-direction.md); [Derived table creation direction](raw/derived-table-creation-direction.md))

## Table Derivation

`Table.make` validates the encoded schema as a flat struct with required, string-named `String` or `Number` fields. It preserves the canonical source as `table.schema`. With no annotated identifier, it derives `table.rowSchema` by adding a required UUIDv7 `id`, exposes that field through `identifier` and `identifierSchema`, and marks it for adapter-side generation. With one annotated identifier, `rowSchema` is the original schema and no generated field is added. Multiple annotations and an unannotated source field named `id` are rejected. `createTable()` is interpreted through a narrow Effect service, so the table definition does not depend on a concrete database client. ([Table implementation](../../src/Table.ts))

## Authored Queries

Each `Query.make` config contains `Request`, `Result`, and `implementation`. Execution encodes the decoded request with `Request`, runs the authored implementation Effect with the encoded value, then decodes the unknown result with `Result`. Request encoding services, result decoding services, implementation failures, and implementation requirements all remain visible in the resulting Effect type. ([Query implementation](../../src/Query.ts))

The implementation Effect may yield `SqliteBun.Database` or another runtime service. This makes the dependency visible at execution without duplicating a Context key in query configuration. CRUD has no privileged generated form: create, read, update, delete, joins, and other database operations are individual authored queries whose schemas state their contracts. This reflects the derivation boundary because query behavior is not mechanically contained in an entity schema. ([Table and query API direction](raw/table-and-query-api-direction.md); [Project thesis](raw/project-thesis.md))

## Persisted References

`PersistedRef.make(commit)(load)` composes authored persistence operations into one shared, write-through value. Construction loads the authoritative value. `get` reads memory, `set`, `update`, and `modify` serialize local fiber mutations, commit before publishing, and publish the value returned by persistence. A failed commit leaves memory unchanged. `refresh` explicitly reloads under the same local mutation lock. Load and commit errors and runtime requirements remain visible in the resulting Effect types. ([PersistedRef implementation](../../src/PersistedRef.ts); [PersistedRef tests](../../test/PersistedRef.test.ts))

This is deliberately a distinct type rather than an `Effect.Ref`. Standard Ref mutations cannot carry database failures or requirements, and their synchronous internals cannot intercept asynchronous persistence. `PersistedRef` composes load and commit operations instead of deriving row selection, missing-row behavior, insert-versus-update policy, authorization, or conflict handling from `Table`. Existing `Query` definitions can supply those operations without adding CRUD behavior to the table interpreter. ([PersistedRef implementation](../../src/PersistedRef.ts); [Query implementation](../../src/Query.ts); [Project thesis](raw/project-thesis.md))

The synchronization guarantee is process-local. Other processes and direct database writers require explicit database concurrency policy, such as an authored optimistic version check. Database changes are not observed until `refresh`, and no background write-behind mode is provided. ([PersistedRef implementation](../../src/PersistedRef.ts); [Project thesis](raw/project-thesis.md))

## Bun SQLite Adapter

The reference adapter supplies two services from one SQLite client Layer: the database service used directly by authored query Effects and the narrow table-creation store used by derived tables. For a synthesized identifier, table creation emits a `TEXT PRIMARY KEY NOT NULL` column whose SQLite default constructs an RFC-compatible UUIDv7. Explicit domain identifiers receive no generated default. SQL APIs remain isolated in the adapter subpath rather than entering the database-neutral root module. ([Bun SQLite adapter](../../src/SqliteBun.ts))

## Contract Evidence

The Bun SQLite integration test derives a table and authors four separate CRUD queries. A database-neutral contract verifies complete create/read/update/delete behavior against a temporary real database. A second table omits domain identity; its create query sends only the source value, SQLite generates a UUIDv7, and `rowSchema` decodes the returned persisted representation. The tests also prove that an explicit identifier suppresses generation, database and schema-codec services remain in query Effect requirements, one runtime Layer supports multiple table definitions, and authored read/update queries can back a `PersistedRef` whose concurrent local updates reach SQLite without lost writes. Focused tests prove failed commits do not change memory, explicit refresh replaces stale memory, and persistence-returned canonical values are published. ([Bun SQLite test](../../test/SqliteBun.test.ts); [PersistedRef tests](../../test/PersistedRef.test.ts); [Adapter contract](../../test/adapterContract.ts))

This evidence covers one scalar table shape and one database. It does not prove portability to materially different databases or justify a general query framework. ([Validation Strategy](validation-strategy.md))

## Explicit Exclusions

Beyond the explicit UUIDv7 identity fallback, table derivation does not infer migrations, relationships, indexes, application defaults, transactions, authorization, retries, idempotency policy, or business behavior. Query implementations may author required behavior explicitly, but `Query.make` does not claim to derive it. ([Project thesis](raw/project-thesis.md); [Table implementation](../../src/Table.ts))
