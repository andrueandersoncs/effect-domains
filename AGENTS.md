# Effect Domains

Effect Domains tests whether Effect Schemas can define domain concepts and operation contracts from which mechanical, lossless representations are derived.

## Project Direction

- Read the [wiki](docs/wiki/README.md) before making design decisions. Be sure to update it regularly.
- Follow [wiki maintenance instructions](docs/wiki/AGENTS.md) for all work under `docs/wiki/`.
- Keep canonical domain models free of persistence, transport, UI, and authorization concerns.
- Derive only mechanical, lossless mappings. Use explicit typed transformations when semantics differ.
- Keep business policy, state transitions, authorization, transactions, compatibility, and migrations explicit.
- Prove the design through materially different vertical slices before extracting a general framework.
- Prefer deep modules and clear escape hatches over annotation-heavy thin wrappers.

## Tooling

Use Bun for project commands:

- `bun install` for dependencies
- `bun run <file-or-script>` to run code
- `bun test` for tests
- `bunx <package> <command>` for package executables
