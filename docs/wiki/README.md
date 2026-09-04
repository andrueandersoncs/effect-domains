# Effect Domains Wiki

This directory is the persistent, source-grounded wiki for the Effect Domains design hypothesis and implementation workspace.

The project asks how much application structure can be derived safely from rich domain schemas without hiding business behavior or forcing different representations to share semantics they do not have.

## Content Map

- [Thesis](thesis.md) — the central claim, derivation boundary, and architectural principles.
- [Tables and Queries](tables-and-queries.md) — the accepted persistence interface and current implementation evidence.
- [Validation Strategy](validation-strategy.md) — the required vertical slices and criteria for judging the hypothesis.
- [Research Agenda](research-agenda.md) — unresolved questions and evidence needed before a general framework is justified.

## Wiki Operations and Sources

- [Wiki instructions](AGENTS.md) — structure, citation rules, review policy, and maintenance workflows.
- [Original project thesis](raw/project-thesis.md) — the initial derivation thesis and architectural boundaries.
- [Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md) — the human direction for Effect-based implementations and declarative public interfaces.
- [Refactoring and compatibility direction](raw/refactoring-and-compatibility-direction.md) — the human direction for clean cutovers without legacy compatibility paths.
- [Domain identifier and basic persistence direction](raw/domain-identifier-and-basic-persistence-direction.md) — the human direction for deriving persistence keys from domain identity and excluding column mapping configuration.
- [Catalog key and table direction](raw/catalog-key-table-direction.md) — the superseded catalog interface and the still-relevant earlier table naming rationale.
- [Derived table creation direction](raw/derived-table-creation-direction.md) — the human direction for mechanically deriving fresh table creation while leaving migrations explicit.
- [Table and query API direction](raw/table-and-query-api-direction.md) — the newer human direction separating table derivation from one-operation authored queries.

Files under `raw/` are immutable source material. Maintained pages synthesize those sources and should cite them close to supported claims.

## Current Status

Persistence now has separate implemented table and query definitions. `Table` and `Query` are Effect Schema classes whose `make` overrides Schema's static constructor: `Table.make({ name, schema })` preserves its canonical source schema and derives a persisted `rowSchema`, adding an adapter-generated UUIDv7 `id` when no `identifier` annotation overrides it; its exhaustive Effect `Match` interpreter recursively reduces supported encoded SchemaAST forms to the scalar table representation. `Query.make({ table, Request, Result, implementation })` defines one operation whose Effect requirements carry the runtime database dependency. Column metadata is `TableField`, a tagged Schema class. `PersistedRef.make({ commit, load })` remains an Effectful namespace constructor because it loads and caches a runtime value rather than constructing a schema record. `SqliteBunRuntime` supplies table writes, UUIDv7 generation, and the database, while integration tests validate authored CRUD, generated identity, and query-backed persisted references.

## Development

Run these commands from the repository root:

```bash
bun install
bun run check
bun run lint
bun run test
```
