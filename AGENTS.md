# Effect Domains

Effect Domains tests whether Effect Schemas can define domain concepts and operation contracts from which mechanical, lossless representations are derived.

We are **never** worried about backward compatibility, always make the changes and refactors as clean as possible and constantly and ruthlessly remove and/or rewrite old legacy code where appropriate

We're essentially trying to build Rails (as in, Ruby on Rails) for Effect. Everything as magical and automatic as possible.

## Project Direction

- Read the [wiki](docs/wiki/README.md) before making design decisions. Be sure to update it regularly.
- Follow [wiki maintenance instructions](docs/wiki/AGENTS.md) for all work under `docs/wiki/`.
- Use Effect for all implementations and program against narrow interfaces with runtime-provided concrete implementations.
- Make final user-facing interfaces declarative. Prefer inspectable schemas, configuration, and annotations over user-authored functions or procedures.
- Do not preserve backward compatibility. Prefer clean cutovers and continuously remove or rewrite legacy code instead of adding shims or deprecated paths.
- Keep canonical domain models free of persistence, transport, UI, and authorization concerns.
- Derive only mechanical, lossless mappings. Use explicit typed transformations when semantics differ.
- Keep business policy, state transitions, authorization, transactions, compatibility, and migrations explicit.
- Prove the design through materially different vertical slices before extracting a general framework.
- Prefer deep modules and clear escape hatches over annotation-heavy thin wrappers.

## Tooling

Use Bun for project commands:

- `bun install` for dependencies
- `bun run <file-or-script>` to run code
- `bun run lint` for Better TypeScript linting
- `bun test` for tests
- `bunx <package> <command>` for package executables

## Rules and Advice

**Every plan is a prediction. Do everything in your power to make sure yours are accurate and effective.**

Keep the docs/ up to date before every commit - this includes the vitepress docs site and the project wiki.