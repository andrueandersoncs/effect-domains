---
layout: home

hero:
  name: Effect Domains
  text: From schema to application.
  tagline: Define your data with Effect Schema. Get SQLite persistence, typed operations, a CLI, MCP tools, and an optional admin. Write business rules where they belong.
  actions:
    - theme: brand
      text: Run your first application
      link: /getting-started
    - theme: alt
      text: Define a resource
      link: /guides/define-a-resource

features:
  - title: Stop rewriting the same record
    details: A resource derives its table, repository, and selected CRUD contracts from your schema. Nullable create fields default to null; declare lists, versions, and transitions beside the record.
  - title: Use the same operations everywhere
    details: The CLI, MCP tools, and generated Application UI share published RPC contracts and handlers. Validation and authorization do not depend on which client you choose.
  - title: Keep business rules in your code
    details: Define inspectable Command specs, then attach explicit Effect implementations. Families share names, policies, and transaction boundaries without hiding business behavior.
---

<div class="home-code">

## Start with a resource

```ts
import { Schema } from "effect"
import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"

const Books = Resource.define({
  name: "books",
  schema: Schema.Struct({
    title: Schema.NonEmptyString,
    author: Schema.NonEmptyString,
    status: Schema.Literals(["planned", "reading", "finished"]),
  }),
  authorization: Authorization.public,
  capabilities: Resource.crud(),
})
```

This specification declares the five routine capabilities. `Resource.compile` derives their SQLite table, repository, and RPC contracts; the typed Effect returned by `Application.compile` assembles those products into the application IR consumed by every adapter.

Compose the resource into an application, supply migration history, and run it with Bun. [The resource guide covers those steps](/guides/define-a-resource); [the first-run tutorial](/getting-started) uses a ready-made reading list.

</div>

<div class="home-intro">

## What this project is—and isn’t

Effect Domains is an experimental TypeScript framework in a Bun workspace, using Effect 4. The implemented persistence adapter is SQLite. These docs describe the current checkout, not a stable release or production deployment recipe.

A schema can describe a book’s fields. It cannot decide who may edit the book, whether an order may be invoiced, or how old data should change. You declare those decisions explicitly. [How the pieces fit](/concepts) explains the boundary.

</div>

<div class="home-paths">

## Find what you need

- **Try it** — [Run a reading list](/getting-started) and see a book in both the CLI and browser.
- **Build with it** — [Define a resource](/guides/define-a-resource), [restrict access](/guides/authorization), or [change a stored schema](/guides/migrations).
- **Look something up** — Find [resource operations](/reference/resources), [runtime options, environment variables, and endpoints](/reference/runtime).
- **Go beyond CRUD** — [Explore the applications](/examples) for transitions, authored operations, transactions, entitlements, and durable execution.

Design rationale and dated verification records live separately in the [project wiki](/wiki/README).

</div>
