# Effect Domains

Effect Domains is a design hypothesis and implementation workspace built around Effect Schema. This repository also serves as its persistent, source-grounded wiki.

The project asks how much application structure can be derived safely from rich domain schemas without hiding business behavior or forcing different representations to share semantics they do not have.

## Content Map

- [Thesis](thesis.md) — the central claim, derivation boundary, and architectural principles.
- [Validation Strategy](validation-strategy.md) — the required vertical slices and criteria for judging the hypothesis.
- [Research Agenda](research-agenda.md) — unresolved questions and evidence needed before a general framework is justified.

## Wiki Operations and Sources

- [Wiki instructions](AGENTS.md) — structure, citation rules, review policy, and maintenance workflows.
- [Bun project guidance](CLAUDE.md) — runtime and tooling conventions for implementation work.
- [Original project thesis](raw/project-thesis.md) — the first immutable human-curated source.

Files under `raw/` are immutable source material. Maintained pages synthesize those sources and should cite them close to supported claims.

## Current Status

The repository is at the hypothesis stage. The thesis defines what may be derived and what must remain explicit, but no vertical slice has yet produced implementation evidence. The next useful milestone is one narrow experiment that exercises a branded value, an entity transition, a typed operation, persistence, versioned transport, and a migration.

## Development

Install dependencies:

```bash
bun install
```

Run the current entry point:

```bash
bun run index.ts
```
