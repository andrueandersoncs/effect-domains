# Thesis

## Central Claim

Model domain concepts and operation contracts as Effect Schemas. Derive representations and routine behavior only where the mapping is mechanical and lossless. Where storage, transport, or business concerns have different semantics, expose an explicit typed transformation. This remains a hypothesis, not a proven premise. ([Project thesis](raw/project-thesis.md))

Effect Schema is an inspectable runtime value as well as a source of TypeScript types, so multiple interpreters can consume one domain description without repeating mechanically equivalent declarations. ([Project thesis](raw/project-thesis.md))

## Core Interface Principles

Project implementations use Effect and narrow runtime interfaces rather than fixed infrastructure. Native Effect RPCs define operation contracts through payload/success/error schemas; `Commands.rpc` derives their JSON codecs, and `Commands.make({ name, group })` adds an injectable unary handler service to the existing RPC group. `Application.make` composes command descriptors with resources. `ApplicationBun.run` supplies the Bun CLI/HTTP entrypoint, keeping transport selection separate from RPC declarations and canonical domain models. These implement the direction, not evidence that it generalizes beyond the exercised slice. ([Commands](../../src/commands.ts); [Book RPCs](../../examples/authored-sql/contracts.ts); [Application](../../src/application.ts); [Bun runtime](../../src/application-bun.ts))

The project does not preserve backward compatibility. Refactors make a clean cutover and remove superseded records, services, shims, and parallel APIs. ([Refactoring and compatibility direction](raw/refactoring-and-compatibility-direction.md))

Intrinsic identity is declared directly with `identifier`; persistence derives its storage key from it. Without domain identity, `Table.make` adds a UUIDv7 `id` to the persistence row only. `Resource.make` keeps a canonical schema distinct from an optional reversible storage schema, so codecs can differ physically without becoming wire contracts. ([Table](../../src/table.ts); [Resource](../../src/resource.ts))

## Derivation Boundary

Strong candidates for derivation are:

- runtime validation and TypeScript types;
- wire codecs;
- branded identifiers and value objects;
- test-data generators;
- equality, formatting, and redaction behavior;
- basic database columns and constraints; and
- routine resource operation contracts.

The benefit sought is less duplicate declaration and less drift between mechanically equivalent representations. ([Project thesis](raw/project-thesis.md))

A schema does not determine business decisions, transitions, authorization, transaction boundaries, indexes, aggregate ownership, historical migration intent, compatibility policy, retries, or idempotency. These concerns require explicit design. Resource defaults, runtime generation, selected list policy, and patch validation are framework semantics defined once; authored SQL or commands still carry semantic policy. ([Project thesis](raw/project-thesis.md); [Resource](../../src/resource.ts); [Authored SQL](../../examples/authored-sql/sqlite.ts))

Explicit authorization can nevertheless be declarative: resource-level scope and action policy are authored once as a closed AST, then interpreted for evaluation, SQL visibility, and inspection. The 2026-09-08 authorization implementation does not infer permissions from domain fields or add them to canonical schemas; its algebra is specific to the supported policy language, not a general schema abstraction. ([Authorization](../../src/authorization.ts); [Policy](../../src/policy.ts); [authorization boundary](tables-and-queries.md#resource-authorization))

## Architectural Shape

The canonical domain model stays clean. Separate interpreters consume schemas for persistence, transport, testing, and documentation. A storage representation with different physical encoding is an explicit reversible transformation, not a second wire model. ([Project thesis](raw/project-thesis.md); [Tables and Queries](tables-and-queries.md#canonical-and-storage-representations))

```text
Domain schemas and operation contracts
    ├── Wire interpreter
    ├── Persistence interpreter
    ├── Test-data interpreter
    └── Documentation interpreter
```

This arrangement aims for deep modules with clear escape hatches rather than annotation-heavy thin wrappers. Persisted resource state is deliberately only in-process synchronization; migration generation requires explicit intent for semantic changes. ([PersistedRef](../../src/persisted-ref.ts); [Migrations](../../src/sqlite-migrations.ts))

## Constraints on Generalization

The project should not begin with a general algebra. It must demonstrate several materially different vertical slices before claiming a framework. Current evidence covers one SQLite adapter, reservations, and supporting integration applications; it explicitly does not prove another database or materially different business-policy domain. ([Validation Strategy](validation-strategy.md#evidence-boundary); [Project thesis](raw/project-thesis.md))
