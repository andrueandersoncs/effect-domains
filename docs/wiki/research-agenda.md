# Research Agenda

This page records established implementation findings and unresolved questions. The source thesis establishes the constraints, while implementation evidence changes which questions remain open. ([Project thesis](raw/project-thesis.md))

## Established Persistence Findings

Persistence is the first implemented product capability. Its public surface accepts a declarative sidecar catalog and compiles full CRUD Effect programs. Each entity receives a distinct Context service, and runtime Layers provide concrete implementations. The first adapter uses Bun SQLite behind the database-neutral interface. ([Persistence Catalog](persistence-catalog.md); [Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md))

The initial contract is now explicit:

- users declare the canonical schema, table, caller-supplied primary key, and optional column renames;
- `create` returns the complete entity;
- primary-key `read` returns `Option`;
- `update` performs complete replacement and returns `Option`;
- idempotent `delete` returns whether a row existed; and
- every adapter must pass one reusable CRUD contract.

The Bun SQLite test demonstrates these semantics, a renamed column, a branded key, original schema codecs with Effect service requirements, and separate entity services. This evidence is limited to the supported scalar row shape and one concrete adapter. ([Bun SQLite test](../../test/SqliteBun.test.ts); [Adapter contract](../../test/adapterContract.ts))

## Remaining Persistence Questions

Further evidence must determine:

- whether a materially different second database can satisfy the same CRUD contract without weakening it;
- how an explicit typed storage representation composes when the canonical encoded schema is not a lossless row shape;
- which additional encoded field shapes earn mechanical support;
- how migrations and transactions remain explicit while integrating cleanly with generated CRUD; and
- whether generated identifiers or database defaults can be described declaratively without hiding real semantics.

These are unresolved capabilities, not commitments for the current persistence interface.

## Effect Schema Capabilities

The current compiler uses public `Schema.toEncoded`, `SchemaAST` guards, and original schema encode/decode Effects for a narrow supported subset. Research and prototypes still need to determine:

- how unions, optional fields, nested structures, records, and recursive schemas should be rejected or represented;
- when annotations remain useful metadata versus becoming a second embedded programming language; and
- which unstable Effect v4 APIs can be isolated without shaping the public contract.

## Interpreter Interface

The compiled persistence catalog establishes one narrow interpreter shape. Future capabilities must still test:

- whether sidecar catalogs remain understandable as declarations grow;
- how explicit escape hatches compose without making the normal interface procedural; and
- whether one shared algebra is clearer than several capability-specific interpreters.

The declarative interface and Effect requirement constraints are established project direction. ([Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md))

## Success and Stop Conditions

The [Validation Strategy](validation-strategy.md) gives evaluation questions, but quantitative or practical thresholds are not defined. Before generalizing, the project should decide what amount of removed duplication justifies the machinery and what signs should stop framework extraction. A valid outcome may be a set of domain-specific patterns rather than a general meta-framework.
