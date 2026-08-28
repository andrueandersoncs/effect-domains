# Effect Domains Wiki

This directory is the persistent, source-grounded wiki for the Effect Domains design hypothesis and implementation workspace.

The project asks how much application structure can be derived safely from rich domain schemas without hiding business behavior or forcing different representations to share semantics they do not have.

## Content Map

- [Thesis](thesis.md) — the central claim, derivation boundary, and architectural principles.
- [Persistence Catalog](persistence-catalog.md) — the accepted declarative full-CRUD design and current implementation evidence.
- [Validation Strategy](validation-strategy.md) — the required vertical slices and criteria for judging the hypothesis.
- [Research Agenda](research-agenda.md) — unresolved questions and evidence needed before a general framework is justified.

## Wiki Operations and Sources

- [Wiki instructions](AGENTS.md) — structure, citation rules, review policy, and maintenance workflows.
- [Original project thesis](raw/project-thesis.md) — the initial derivation thesis and architectural boundaries.
- [Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md) — the human direction for Effect-based implementations and declarative public APIs.

Files under `raw/` are immutable source material. Maintained pages synthesize those sources and should cite them close to supported claims.

## Current Status

Persistence now has an implemented declarative full-CRUD path. A sidecar catalog compiles canonical Effect Schemas into entity-specific Effect services, and a Bun SQLite Layer supplies the first concrete adapter. A reusable contract fixes the CRUD semantics. This is evidence for one persistence path, not yet proof of a general framework or cross-database portability. ([Persistence Catalog](persistence-catalog.md); [Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md))

## Development

Run these commands from the repository root.

Install dependencies:

```bash
bun install
```

Validate the persistence implementation:

```bash
bun run check
bun test
```
