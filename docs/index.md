---
layout: home

hero:
  name: Effect Domains
  text: Derive the routine. Author the meaning.
  tagline: Build from canonical Effect Schemas. Derive persistence, RPC, CLI, and admin interfaces. Keep business policy explicit.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Read the thesis
      link: /wiki/thesis
    - theme: alt
      text: Browse the contract
      link: /wiki/tables-and-queries

features:
  - title: One canonical description
    details: Define the domain with an Effect Schema, then derive storage representation, codecs, repository operations, and selected resource contracts where the mapping is mechanical.
  - title: Policy stays explicit
    details: Authorization, domain transitions, migration intent, transaction boundaries, and storage transformations are authored decisions—not consequences inferred from a schema.
  - title: Runnable boundaries
    details: "Small applications keep the generated path concrete: SQLite history, an Effect RPC server, a generated CLI, and an opt-in administrative surface."
---

<div class="home-intro">

## A narrow derivation boundary

Effect Domains treats an Effect Schema as a runtime domain description that multiple interpreters can consume. The goal is to remove duplicate declarations that must stay mechanically equivalent—not to make business decisions disappear.

What derives is deliberately bounded: routine columns and codecs, repository operations, selected RPCs, JSON CLI inputs, and inspection data. What changes the meaning of an application remains visible in authored code: authorization, commands, transactions, migrations, indexes, retry and idempotency policy, and semantic storage transforms.

[Start with the minimal runnable application](/getting-started) or read the maintained [thesis](/wiki/thesis) and [resource contract](/wiki/tables-and-queries).

</div>

<div class="home-code">

## One schema. A working resource.

```ts
import { Schema } from "effect"
import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"

const BookSchema = Schema.Struct({
  title: Schema.NonEmptyString,
  pageCount: Schema.Int.check(Schema.isGreaterThan(0)),
})

const Books = Resource.make({
  name: "books",
  schema: BookSchema,
  authorization: Authorization.public,
  operations: Resource.crud,
})
```

The schema describes books; the resource declares access and published operations. Effect Domains derives the table, repository, and selected RPC contracts. Public access is an explicit choice—not a default. See the [authorization contract](/wiki/tables-and-queries#resource-authorization) for typed policies and their runtime boundaries.

</div>

<div class="home-paths">

## Follow the evidence

- **Run a small vertical slice** — [Basic CRUD onboarding](/getting-started) walks through the generated book resource, server, CLI, and admin surface.
- **Understand the claim** — [Thesis](/wiki/thesis) explains the mechanical derivation boundary and the constraints on generalization.
- **Inspect the implementation contract** — [Tables and Queries](/wiki/tables-and-queries) covers resources, authorization, commands, migrations, and runtime behavior.
- **Keep claims bounded** — [Validation Strategy](/wiki/validation-strategy) records exercised behavior and its limits.

The [workspace README](../README.md) and [project wiki](/wiki/README) remain the detailed, source-grounded references.

</div>
