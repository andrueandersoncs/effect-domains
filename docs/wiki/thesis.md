# Thesis

## Central Claim

Model domain concepts and operation contracts as Effect Schemas. Derive representations and routine behavior only where the mapping is mechanical and lossless. Where storage, transport, or business concerns have different semantics, expose an explicit typed transformation. This remains a hypothesis, not a proven premise. ([Project thesis](raw/project-thesis.md))

Effect Schema is an inspectable runtime value as well as a source of TypeScript types, so multiple interpreters can consume one domain description without repeating mechanically equivalent declarations. ([Project thesis](raw/project-thesis.md))

## Core Interface Principles

Project implementations use Effect and narrow runtime interfaces rather than fixed infrastructure. Native Effect RPCs define operation contracts through payload/success/error schemas; `Commands.rpc` derives their JSON codecs, and `Commands.make({ name, group })` adds an injectable unary handler service to the existing RPC group. `Application.make({ name, resources?, commands? })` composes any supplied descriptors with resources. `ApplicationBun.run` returns the Bun CLI/HTTP `Effect`, while `runMain` runs a fully provided one. This keeps transport selection separate from RPC declarations and canonical domain models. ([Commands](../../packages/effect-domains/src/commands.ts); [Book RPCs](../../apps/authored-sql/contracts.ts); [Application](../../packages/effect-domains/src/application.ts); [Bun runtime](../../packages/effect-domains/src/application-bun.ts))

The project does not preserve backward compatibility. Refactors make a clean cutover and remove superseded records, services, shims, and parallel APIs. ([Refactoring and compatibility direction](raw/refactoring-and-compatibility-direction.md))

Intrinsic identity is declared directly with `identifier`; persistence derives its storage key from it. Without domain identity, `Table.make` adds a UUIDv7 `id` to the persistence row only. `Resource.make` keeps a canonical schema distinct from an optional reversible storage schema, so codecs can differ physically without becoming wire contracts. ([Table](../../packages/effect-domains/src/table.ts); [Resource](../../packages/effect-domains/src/resource.ts))

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

A schema does not determine business decisions, transitions, authorization, transaction boundaries, indexes, aggregate ownership, historical migration intent, compatibility policy, retries, or idempotency. These concerns require explicit design. Resource defaults, runtime generation, typed subject-to-field creation bindings, selected list policy, and patch validation are framework semantics defined once; authored SQL or commands still carry semantic policy. A subject binding derives a trusted create value and does not infer a permission. ([Project thesis](raw/project-thesis.md); [Resource](../../packages/effect-domains/src/resource.ts); [Authored SQL](../../apps/authored-sql/sqlite.ts))

Explicit authorization can nevertheless be declarative: resource-level scope and action policy are authored once as a closed AST, then interpreted for evaluation, SQL visibility, and inspection. The authorization implementation does not infer permissions from domain fields or add them to canonical schemas; its algebra is specific to the supported policy language, not a general schema abstraction. For SQL visibility, native Booleans use SQLite numeric `0`/`1` comparison; semantic Boolean codecs are rejected rather than approximated. ([Authorization](../../packages/effect-domains/src/authorization.ts); [Policy](../../packages/effect-domains/src/policy.ts); [SQL interpreter](../../packages/effect-domains/src/policy-sql.ts); [authorization boundary](tables-and-queries.md#resource-authorization))

## Architectural Shape

The canonical domain model stays clean. Separate interpreters consume schemas for persistence, transport, testing, documentation, and an opt-in administrative interface. The repository is a private Bun workspace: [`packages/effect-domains`](../../packages/effect-domains/) is the framework, [`packages/example-support`](../../packages/example-support/) holds shared fixtures, and [`apps`](../../apps/) contains independently runnable applications. The admin's inspection-derived operation and resource data is descriptive; its presentation labels, columns, and descriptions are application configuration, not a canonical domain model. Its browser app is prebuilt from [client](../../apps/admin/src/client.ts) and [stylesheet](../../apps/admin/src/style.css) sources, while the native [adapter](../../packages/effect-domains/src/application-admin.ts) loads the prebuilt assets only at runtime. A storage representation with different physical encoding is an explicit reversible transformation, not a second wire model. ([Project thesis](raw/project-thesis.md); [Inspection](../../packages/effect-domains/src/application-inspect.ts); [Tables and Queries](tables-and-queries.md#canonical-and-storage-representations))

```text
Domain schemas and operation contracts
    ├── Wire interpreter
    ├── Persistence interpreter
    ├── Test-data interpreter
    └── Documentation interpreter
```

This arrangement aims for deep modules with clear escape hatches rather than annotation-heavy thin wrappers. Persisted resource state is deliberately only in-process synchronization; migration generation requires explicit intent for semantic changes; transactions remain authored handler concerns. ([PersistedRef](../../packages/effect-domains/src/persisted-ref.ts); [Migrations](../../packages/effect-domains/src/sqlite-migrations.ts); [Inspection boundary](../../packages/effect-domains/src/application-inspect.ts))

## Constraints on Generalization

The project should not begin with a general algebra. It must demonstrate several materially different vertical slices before claiming a framework. Previously dated evidence covers one SQLite adapter, reservations, and supporting integration applications; it explicitly does not prove another database or materially different business-policy domain. ([Validation Strategy](validation-strategy.md#evidence-boundary); [Project thesis](raw/project-thesis.md))

