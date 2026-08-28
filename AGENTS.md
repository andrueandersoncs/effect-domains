# Effect Domains

Effect Domains tests whether Effect Schemas can define domain concepts and operation contracts from which mechanical, lossless representations are derived.

## Project Direction

- Read the [wiki](docs/wiki/README.md) before making design decisions. Be sure to update it regularly.
- Follow [wiki maintenance instructions](docs/wiki/AGENTS.md) for all work under `docs/wiki/`.
- Use Effect for all implementations and program against narrow interfaces with runtime-provided concrete implementations.
- Make final user-facing interfaces declarative. Prefer inspectable schemas, configuration, and annotations over user-authored functions or procedures.
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

## Rules and Advice

**Every plan is a prediction. Do everything in your power to make sure yours are accurate and effective.**