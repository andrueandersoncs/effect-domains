# Effect Domains

## Original Idea

A meta-framework around Effect where you base your entire application on domain models implemented as Effect Schemas.

- Define those models in Effect https://www.effect.website/docs/v4/api/effect/Schema

- Define the domain once in a rich, executable form, then derive other representations wherever the mapping is mechanical and lossless.

Effect Schema is a promising foundation because schemas are inspectable values rather than TypeScript types alone. This allows multiple interpreters to consume the same domain description.

### Thesis

Model domain concepts and operation contracts as Effect Schemas. Derive representations and routine behavior wherever the derivation is lossless. Use explicit, typed transformations where storage, transport, or business concerns differ from the domain.

### Good Candidates for Derivation

- Runtime validation and TypeScript types
- Wire codecs
- Branded identifiers and value objects
- Test data generators
- Equality, formatting, and redaction behavior
- Basic database columns and constraints
- Operation input, output, and error contracts

These are useful derivations because they remove duplicate declarations and reduce drift.

### What Must Still Be Authored

A data schema does not contain enough information to derive all application behavior. The following usually require explicit design and implementation:

- Business decisions and policies
- State transitions over time
- Authorization
- Transactions and consistency rules
- Database indexes and query-driven denormalization
- Relationships and aggregate ownership
- Historical database migrations
- Wire-format compatibility and versioning
- Operational behavior such as retries and idempotency

A schema can describe valid `Order` data, for example. It cannot determine whether a paid order may be cancelled, who may cancel it, or which compensating actions must run.

Therefore, business operations should be **defined in terms of** domain models rather than assumed to be mechanically derivable from them. Their contracts and supporting machinery may be derived, but their policy and behavior must be authored.

### Design Rules

1. **Keep the domain model clean.** Do not turn the canonical schema into a god object filled with database, HTTP, UI, and authorization details.
2. **Use separate interpreters.** Persistence, transport, testing, and documentation should consume the domain description without becoming part of it.
3. **Derive only when the mapping is lossless.** If two representations have different semantics, use an explicit transformation.
4. **Make differences visible and typed.** Storage models and wire models may differ from domain models. This is healthy when the distinction reflects a real concern.
5. **Treat behavior as first-class.** Constructors, invariants, policies, and operations belong in domain modules alongside the schemas, not hidden inside infrastructure derivation.
6. **Keep migrations independent.** A current schema describes the desired present state; a migration records the historical path between states.
7. **Provide escape hatches.** A derivation system should make common cases easy without making exceptional cases impossible.
8. **Prefer deep modules.** Derivation machinery should hide complexity behind small interfaces. Avoid thin wrappers and annotation-heavy interfaces that merely move complexity around.

A useful conceptual shape is:

```text
Domain schemas and operations
    ├── Wire interpreter
    ├── Persistence interpreter
    ├── Test-data interpreter
    └── Documentation interpreter
```

### Validation Strategy

Before building a general framework, prove the approach with narrow vertical slices. Each slice should include:

- Branded domain values
- An entity with a meaningful state transition
- A business operation with typed domain errors
- A database representation
- A versioned wire representation
- Explicit transformations where representations differ
- A database migration

Evaluate each slice by asking:

1. How much duplicate declaration disappeared?
2. Did domain changes propagate safely?
3. How much annotation machinery was required?
4. Were escape hatches straightforward?
5. Is the result easier to understand than handwritten adapters?

If the approach works across several materially different domains, it may justify a general algebra. Until then, treat it as a design hypothesis to test rather than a premise that every part of the application must obey.
