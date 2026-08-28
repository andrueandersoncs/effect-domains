# Effect Domains Wiki

This directory is the persistent, source-grounded wiki for the Effect Domains design hypothesis and implementation workspace.

The project asks how much application structure can be derived safely from rich domain schemas without hiding business behavior or forcing different representations to share semantics they do not have.

## Content Map

- [Thesis](thesis.md) — the central claim, derivation boundary, and architectural principles.
- [Validation Strategy](validation-strategy.md) — the required vertical slices and criteria for judging the hypothesis.
- [Research Agenda](research-agenda.md) — unresolved questions and evidence needed before a general framework is justified.

## Wiki Operations and Sources

- [Wiki instructions](AGENTS.md) — structure, citation rules, review policy, and maintenance workflows.
- [Original project thesis](raw/project-thesis.md) — the initial derivation thesis and architectural boundaries.
- [Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md) — the human direction for Effect-based implementations and declarative public APIs.

Files under `raw/` are immutable source material. Maintained pages synthesize those sources and should cite them close to supported claims.

## Current Status

The repository is at the hypothesis stage. Persistence is the first desired capability. Its public interface must be declarative, while its compiled operations use Effect requirements to depend on runtime-provided persistence implementations. The next planning step is to define the smallest complete persistence declaration and the interface contract its adapters must satisfy. ([Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md))

## Development

Run these commands from the repository root.

Install dependencies:

```bash
bun install
```

Run the current entry point:

```bash
bun run index.ts
```
