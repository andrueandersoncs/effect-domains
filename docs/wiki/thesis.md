# Thesis

## Central Claim

Model domain concepts and operation contracts as Effect Schemas. Derive other representations and routine behavior only where the mapping is mechanical and lossless. Where storage, transport, or business concerns have different semantics, make the difference visible through an explicit typed transformation. This is the project’s core hypothesis, not yet a proven premise. ([Project thesis](raw/project-thesis.md))

Effect Schema is relevant because a schema is an inspectable runtime value as well as a source of TypeScript types. In principle, multiple interpreters can consume the same domain description without repeating declarations. ([Project thesis](raw/project-thesis.md))

## Core Interface Principles

All project implementations use Effect and depend on interfaces rather than fixed concrete infrastructure. Effect Context and Requirements make runtime dependencies explicit, while runtime-provided implementations satisfy those requirements. A capability such as persistence may therefore derive mappings and execute operations without coupling its public contract to one database implementation. ([Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md))

The final user-facing product favors inspectable schemas, configurations, and annotations across capabilities. Mechanical behavior is derived from those declarations. Behavior that is not present in a schema remains explicitly authored: the persistence interface therefore accepts an Effect implementation for each query while still deriving its request and result codecs. ([Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md); [Table and query API direction](raw/table-and-query-api-direction.md))

The project does not preserve backward compatibility. Refactors should make a clean cutover to the best current design and remove or rewrite superseded code instead of retaining deprecated functions, shims, or parallel interfaces. ([Refactoring and compatibility direction](raw/refactoring-and-compatibility-direction.md))

Intrinsic domain meaning should be declared once and interpreted mechanically. When identity has domain meaning, it is marked directly with `Domain.identifier`, and persistence derives its storage key from that annotation rather than requiring duplicate key configuration. Current table derivation does not force persistence-only identity into the canonical schema: when no domain identifier exists, `Table.make` adds a generated UUIDv7 `id` only to its persisted `rowSchema`. This fallback is persistence policy, not inferred domain meaning, and it supersedes the older raw-source requirement for exactly one annotation. `Table.make` otherwise supplies only the physical table name, while encoded field names supply column names. Fresh table creation remains derived and migrations remain explicit. ([Table implementation](../../src/Table.ts); [Table and query API direction](raw/table-and-query-api-direction.md); [Domain identifier and basic persistence direction](raw/domain-identifier-and-basic-persistence-direction.md); [Catalog key and table direction](raw/catalog-key-table-direction.md); [Derived table creation direction](raw/derived-table-creation-direction.md))

This declarative constraint does not make non-mechanical behavior derivable. Business behavior and semantic transformations still need explicit authorship, but that authored behavior must remain distinct from the normal mechanically derived path. ([Project thesis](raw/project-thesis.md); [Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md))

## Derivation Boundary

The strongest candidates for derivation are representations whose meaning is already present in the schema:

- runtime validation and TypeScript types;
- wire codecs;
- branded identifiers and value objects;
- test-data generators;
- equality, formatting, and redaction behavior;
- basic database columns and constraints; and
- operation input, output, and error contracts.

The intended benefit is less duplicate declaration and less drift between mechanically equivalent representations. ([Project thesis](raw/project-thesis.md))

A schema does not contain enough information to derive business decisions, state transitions, authorization, transaction boundaries, indexes, aggregate ownership, historical migrations, compatibility policy, retries, or idempotency. These concerns require explicit design and implementation. Operations should be defined in terms of domain models, but their policy and behavior remain authored. ([Project thesis](raw/project-thesis.md))

## Architectural Shape

The canonical domain model stays clean. Separate interpreters consume domain schemas for persistence, transport, testing, and documentation. When an interpreter’s representation differs semantically from the domain, an explicit transformation connects them. ([Project thesis](raw/project-thesis.md))

```text
Domain schemas and operations
    ├── Wire interpreter
    ├── Persistence interpreter
    ├── Test-data interpreter
    └── Documentation interpreter
```

This arrangement aims for deep interpreter modules with small interfaces. It rejects both a domain-schema “god object” and thin wrappers that merely move complexity into annotations. Exceptional cases need clear escape hatches. ([Project thesis](raw/project-thesis.md))

## Constraints on Generalization

The project should not begin with a general algebra. It must first demonstrate the approach in several materially different vertical slices. A framework is justified only if those experiments show that useful declarations disappear, changes propagate safely, annotation cost stays low, exceptions remain straightforward, and the result is easier to understand than handwritten adapters. ([Validation Strategy](validation-strategy.md); [Project thesis](raw/project-thesis.md))
