# Thesis

## Central Claim

Model domain concepts and operation contracts as Effect Schemas. Derive representations and routine behavior only where the mapping is mechanical and lossless. Where storage, transport, or business concerns have different semantics, expose an explicit typed transformation. This remains a hypothesis, not a proven premise. ([Project thesis](raw/project-thesis.md))

Effect Schema is an inspectable runtime value as well as a source of TypeScript types, so multiple interpreters can consume one domain description without repeating mechanically equivalent declarations. ([Project thesis](raw/project-thesis.md))

## Core Interface Principles

Project implementations use Effect and narrow runtime interfaces. `Resource.define`, `Command.define`, `ReadModel.define`, and `Application.define` produce inspectable authoring syntax; they contain no table, repository, RPC group, handler, SQL executor, or adapter state. Explicit compiler boundaries derive those products. `Command.implement` is the authored Effect seam, and `Application.compile` returns a typed Effect that yields the one authoritative `ApplicationIR` consumed by runtime, CLI, MCP, Application UI, and inspection adapters; applications execute it explicitly at their composition boundary. ([Resource](../../packages/effect-domains/src/resource.ts); [Command](../../packages/effect-domains/src/command.ts); [ReadModel](../../packages/effect-domains/src/read-model.ts); [Application](../../packages/effect-domains/src/application.ts))

The project does not preserve backward compatibility. Refactors make a clean cutover and remove superseded records, services, shims, and parallel APIs. ([Refactoring and compatibility direction](raw/refactoring-and-compatibility-direction.md))

Intrinsic identity is declared directly with `identifier`; persistence derives its storage key from it. Without domain identity, `Table.make` adds a UUIDv7 `id` to the persistence row only. `Resource.define` keeps canonical and optional reversible storage schemas declarative; `Resource.compile` derives their physical and runtime representations.

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

A schema does not determine business decisions, transitions, authorization, transaction boundaries, indexes, aggregate ownership, historical migration intent, compatibility policy, retries, or idempotency. Resource capability and creation-source syntax states the framework semantics explicitly; `Command.implement` and authored SQL retain semantic policy.

Explicit authorization can nevertheless be declarative: resource-level scope and action policy are authored once as a closed AST, validated, snapshotted, frozen, compiled, and registered in one construction. It is then interpreted for evaluation, SQL visibility, and inspection. The authorization implementation does not infer permissions from domain fields or add them to canonical schemas; its algebra is specific to the supported policy language, not a general schema abstraction. For SQL visibility, native Booleans use SQLite numeric `0`/`1` comparison; semantic Boolean codecs are rejected rather than approximated. ([Authorization](../../packages/effect-domains/src/authorization.ts); [Policy](../../packages/effect-domains/src/policy.ts); [SQL interpreter](../../packages/effect-domains/src/policy-sql.ts); [authorization boundary](tables-and-queries.md#resource-authorization))

## Architectural Shape

The canonical domain model stays clean. Separate interpreters consume schemas for persistence, transport, testing, documentation, and the generated Application UI. The repository is a private Bun workspace: [`packages/effect-domains`](../../packages/effect-domains/) is the framework, [`packages/example-support`](../../packages/example-support/) holds shared fixtures, and [`examples`](../../examples/) contains independently runnable examples; [`apps/application-ui`](../../apps/application-ui/) is the shared browser interpreter. Inspection's physical metadata is JSON-encoded native `Table.snapshot`, rather than a duplicate DTO; presentation remains external to canonical schemas.

```text
ResourceSpec ── Resource compiler ──┐
CommandSpec + implementation ──────┼── Application compiler ──► ApplicationIR
ReadModel syntax ── shared folds ──┘                               ├── runtime
FieldIR ── storage/auth/table interpreters                         ├── CLI / MCP / Application UI
                                                                 └── inspection
```

This arrangement aims for deep modules with clear escape hatches rather than annotation-heavy thin wrappers. Caching and concurrency policy remain application concerns; migration steps and copy semantics are explicit authored artifacts, not inferred plans; transactions remain authored handler concerns. Operational diagnostics use native Effect services in the application rather than a framework wrapper. ([Authored SQL](../../examples/expense-ledger/sqlite.ts); [Migrations](../../packages/effect-domains/src/sqlite-migrations.ts); [Workflow diagnostics](../../examples/report-exports/workflow.ts))

## Constraints on Generalization

The project should not begin with a general algebra. It must demonstrate several materially different vertical slices before claiming a framework. Previously dated evidence covers one SQLite adapter, reservations, and supporting integration applications; it explicitly does not prove another database or materially different business-policy domain. ([Validation Strategy](validation-strategy.md#evidence-boundary); [Project thesis](raw/project-thesis.md))

