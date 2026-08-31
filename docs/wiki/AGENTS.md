# Effect Domains Wiki Instructions

## Purpose

This directory is the persistent, source-grounded wiki for the Effect Domains implementation workspace. The wiki tracks domain concepts, architecture, experiments, decisions, evidence gaps, and conclusions about deriving application representations from Effect Schemas.

The governing sources are the [Project thesis](raw/project-thesis.md), the [Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md), the [Refactoring and compatibility direction](raw/refactoring-and-compatibility-direction.md), the [Domain identifier and basic persistence direction](raw/domain-identifier-and-basic-persistence-direction.md), the [Catalog key and table direction](raw/catalog-key-table-direction.md), the [Derived table creation direction](raw/derived-table-creation-direction.md), and the newer [Table and query API direction](raw/table-and-query-api-direction.md).

## Roles and Review

- The human curates files in `raw/`, sets direction, asks questions, and makes architectural or ambiguous judgment calls.
- The LLM maintains all synthesis outside `raw/`, including summaries, cross-links, consistency, indexing, structure, and Git history.
- Apply safe, evidence-backed synthesis and bookkeeping changes directly.
- Flag ambiguous interpretations, conflicting architectural choices, and changes to the thesis for human review.

## Source Contract

- Treat every file in `raw/` as immutable. Never rewrite, rename, move, or delete one during wiki work.
- A human may add new source files to `raw/`.
- Cite sources close to the claims they support with standard relative Markdown links.
- Distinguish source-backed facts from wiki analysis, proposals, and unresolved questions.
- Preserve disagreement between sources and name the provenance of each position.

## Wiki Structure

Keep the wiki root flat until several dozen maintained pages or a clear topic cluster makes it hard to scan.

Page types:

1. **Synthesis pages** explain established concepts, boundaries, and relationships across sources.
2. **Experiment pages** describe a vertical slice, its implementation evidence, and its evaluation.
3. **Decision pages** record an accepted architectural choice, its context, and consequences.
4. **Research-agenda pages** collect unresolved questions and evidence needed to answer them.

Create only pages that currently earn their place. Use lowercase kebab-case filenames, except for conventional files such as `README.md` and `AGENTS.md`. Use descriptive Markdown headings and standard relative links such as `[Thesis](thesis.md)`, never wikilinks.

`README.md` is the landing page and content map. Read it first. Update it whenever a maintained page is created, renamed, moved, deleted, or materially changed. Every maintained root page must appear there with a short description.

## Domain Boundaries

Follow these source-backed project rules unless newer human-curated evidence changes them:

- Model domain concepts and operation contracts with Effect Schemas.
- Implement project capabilities with Effect and program against narrow interfaces whose concrete implementations are supplied at runtime.
- Favor inspectable schemas, configuration, and annotations for mechanically derivable interfaces. Require explicit authored Effect implementations for query behavior that is not present in schemas.
- Do not preserve backward compatibility. Make clean cutovers and remove or rewrite legacy code rather than retaining shims, deprecations, or parallel APIs.
- Derive a representation only when the mapping is mechanical and lossless.
- Use explicit typed transformations when domain, storage, transport, or business semantics differ.
- Keep persistence, wire, testing, and documentation concerns in separate interpreters rather than loading them into the canonical domain schema.
- Express intrinsic entity identity with `Domain.identifier`; persistence derives the storage key from it.
- Define tables with `Table.make(schema, { name })`; this newer direction supersedes the earlier catalog-key-as-capability interface.
- Use encoded field names directly as database column names.
- Derive fresh table creation from the table definition and encoded schema; keep existing-table migrations explicit.
- Define one operation per `Query.make`; use request/result schemas and an authored Effect implementation whose requirements carry the runtime database.
- Treat business policies, authorization, transactions, migrations, compatibility, and operational behavior as authored concerns.
- Validate the hypothesis through materially different vertical slices before generalizing a framework.
- Prefer deep modules and straightforward escape hatches over annotation-heavy thin wrappers.

See the [Project thesis](raw/project-thesis.md), [Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md), [Refactoring and compatibility direction](raw/refactoring-and-compatibility-direction.md), [Domain identifier and basic persistence direction](raw/domain-identifier-and-basic-persistence-direction.md), [Catalog key and table direction](raw/catalog-key-table-direction.md), and [Derived table creation direction](raw/derived-table-creation-direction.md) for the complete source wording.

## Workflows

### Ingest

1. Read this file, `README.md`, the new immutable source, and every affected maintained page.
2. Identify new facts, changed confidence, contradictions, connections, and gaps.
3. Integrate the evidence across all affected pages. Add citations close to claims.
4. Update cross-links and `README.md`.
5. Commit the complete ingest once. Name the source and explain which synthesis changed and why in the commit body.
6. Report the changes and any question that needs human direction.

### Query

1. Read this file and `README.md`; consult Git history when sequence matters.
2. Follow maintained pages first, then inspect raw sources when confirmation is needed or a gap appears.
3. Answer with links to both the maintained synthesis and supporting raw sources. State contradictions and missing knowledge directly.
4. If the answer adds durable analysis, integrate it, update the index and links, and commit it as one query-driven change. Keep one-off answers in the conversation.

### Lint

Check all maintained pages, relevant sources, links, and recent Git history for hidden contradictions, stale claims, missing or orphaned pages, broken citations, weak cross-links, evidence gaps, and structural debt. Apply safe fixes directly. Route judgment calls to the human. If files change, update the index and commit all lint fixes once.

### Compact

Merge repeated material, rewrite decayed synthesis, and remove pages that no longer earn their place. Preserve evidence and fix every inbound link, citation, and index in the same change. Add a subdirectory with its own `README.md` only when a real topic cluster makes the root hard to scan. Commit the compaction once.

### Commit

Finish each wiki-changing operation with one coherent commit. Use a conventional title. In the body, record what changed, why the synthesis changed, the sources involved, and unresolved gaps. Git history is the chronological record; do not create `log.md`.

## Implementation Conventions

Use Bun for project commands:

- `bun install` for dependencies
- `bun run <file-or-script>` to run code
- `bun test` for tests
- `bunx <package> <command>` for package executables

Keep current implementation evidence separate from claims that the broader framework design has been validated.
