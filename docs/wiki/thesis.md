# Thesis

## Central Claim

Model domain concepts and operation contracts as Effect Schemas. Derive other representations and routine behavior only where the mapping is mechanical and lossless. Where storage, transport, or business concerns have different semantics, make the difference visible through an explicit typed transformation. This is the project’s core hypothesis, not yet a proven premise. ([Project thesis](raw/project-thesis.md))

Effect Schema is relevant because a schema is an inspectable runtime value as well as a source of TypeScript types. In principle, multiple interpreters can consume the same domain description without repeating declarations. ([Project thesis](raw/project-thesis.md))

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
