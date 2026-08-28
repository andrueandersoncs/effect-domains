# Persistence Catalog

## Decision

Persistence is the first Effect Domains capability, and its first public target is full CRUD. The normal user-facing interface is a declarative sidecar catalog: users provide canonical Effect Schemas plus persistence facts that cannot be derived, while Effect Domains constructs executable Effect programs. This applies the project-wide requirement for declarative interfaces and runtime-provided Effect implementations. ([Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md))

The catalog keeps persistence metadata outside the canonical domain schema. Each entry declares a schema, table, primary-key field, and optional column renames. The compiler derives encoded row metadata only for flat, required `String` and `Number` fields. This preserves the thesis boundary: mechanical mappings are derived, while concern-specific facts remain explicit. ([Thesis](thesis.md); [Project thesis](raw/project-thesis.md))

## Generated Capability

Compilation creates one distinct Effect Context service per entity and exposes four domain-facing programs:

- `create(entity)` inserts and returns a complete entity;
- `read(key)` returns `Option<Entity>`;
- `update(entity)` performs complete replacement and returns `Option<Entity>`; and
- `delete(key)` is idempotent and reports whether a row existed.

The generated programs run the original Effect Schema encoder and decoder. Schema codec services therefore remain visible in Effect Requirements. The runtime database client is not part of the public root module; an adapter Layer provides each generated entity service. ([Persistence compiler](../../src/Persistence.ts))

## Bun SQLite Adapter

The reference adapter uses `@effect/sql-sqlite-bun` behind the `effect-domains/sqlite-bun` package boundary. It consumes compiled field metadata, maps schema field names to database column names, uses escaped identifiers and bound values, and translates Effect SQL failures into the database-neutral `PersistenceError`. Tables must already exist. ([Bun SQLite adapter](../../src/SqliteBun.ts))

Effect v4 SQL APIs are currently unstable, so the project pins the exact Effect RC and contains those imports inside the adapter. No Effect SQL type appears in the database-neutral root API. ([Package manifest](../../package.json); [Bun SQLite adapter](../../src/SqliteBun.ts))

## Contract Evidence

A reusable database-neutral contract fixes the observable adapter semantics. The Bun SQLite integration test runs that contract against a real temporary database and covers a branded key, a service-dependent schema codec, and a renamed column. It also confirms that two declared entities compile to separate Context services. ([Adapter contract](../../test/adapterContract.ts); [Bun SQLite test](../../test/SqliteBun.test.ts))

The current evidence validates this full-CRUD persistence path for one adapter. It does not yet show that the interface works across materially different databases or that the broader Effect Domains thesis generalizes. The [Validation Strategy](validation-strategy.md) still requires additional vertical slices and adapters.

## Explicit Exclusions

This capability does not derive migrations, table creation, relationships, indexes, generated identifiers, defaults, patches, arbitrary queries, transactions, authorization, or business policy. Those concerns are either later explicit capabilities or remain application-authored under the project thesis. ([Project thesis](raw/project-thesis.md))
