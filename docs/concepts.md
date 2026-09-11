---
description: Understand schemas, resources, applications, and the boundary between generated operations and business rules.
---

# How the pieces fit

Effect Domains removes repeated descriptions of the same data. It does not try to derive an entire application from a record type.

Consider the [reading list](/getting-started). A book has a title, an author, and a reading status. Those fields must agree across storage, request validation, CLI input, and admin forms. Writing each representation separately creates opportunities for drift. Effect Schema provides an inspectable runtime description that the framework can reuse.

## Schema: what a value means

The canonical schema describes application data: field types, allowed statuses, and valid ratings. “Canonical” means the representation your application works with, rather than the representation SQLite happens to store.

A rating between 1 and 5 belongs in that schema. The name of a SQLite index, a user's permissions, and the label on an admin form do not.

Storage can have different semantics. The [field-notes example](../examples/field-notes/storage.ts) stores encrypted report text but uses plaintext in the application. That requires an explicit reversible storage codec; encryption does not become the wire format, and it does not grant permission to read a note.

## Resource: how records are stored and exposed

A resource combines a canonical schema with declarations for:

- authorization;
- the operations to publish;
- creation defaults, generated values, or trusted subject bindings;
- supported list filters and a page limit;
- optional storage codecs and relational constraints.

From this, the framework constructs a table, repository, and selected RPC contracts and handlers. A **repository** is the local Effect interface to stored rows. An **RPC operation** is a published contract with input, success, and error schemas.

These are separate decisions. A resource may publish only `get` and `list`, or publish no operations at all, while retaining repository methods for application code. Omitting a published operation is not an authorization policy: local repository calls still need appropriate policy and a subject where required.

See the [resource reference](/reference/resources) for the exact operation contracts.

## Application: which operations belong together

`Application.make({ name, parts })` composes resources, native Effect RPC bundles, and nested applications. An authored bundle contains a native RPC group and its handler layer.

This is where routine record operations and business commands meet. An order application can expose generated read operations and an authored `issueInvoice` operation without inventing a second application framework.

```text
Canonical schema + resource configuration
    ├── SQLite table and repository
    └── Selected RPC contracts and handlers
                │
Authored RPCs ───┤
                ▼
           Application
                ├── HTTP RPC → generated CLI
                ├── MCP tools
                └── Optional browser admin
```

The application is a description. `ApplicationBun.run` supplies the runtime: database history, services, startup work, background layers, and HTTP routes. See [runtime and clients](/reference/runtime).

## Generated CRUD versus business commands

Changing a book's notes is a record update. Confirming a stock reservation is not: it must check the current reservation state and keep stock accounting consistent within a transaction.

The [reservation application](../examples/reservations/sqlite.ts) therefore authors its transitions using native Effect RPC handlers and SQL. Its generated resources expose reads, not unrestricted writes that would bypass those transitions.

| Requirement | Where it belongs |
| --- | --- |
| Title must not be empty | Canonical schema |
| Missing notes default to `null` on create | Resource creation configuration |
| A user can read only their tenant’s tasks | Explicit resource authorization policy |
| A reservation can only be confirmed from a permitted state | Authored handler |
| Two writes must commit together | Authored transaction |
| Report text is encrypted at rest | Explicit storage codec and runtime service |
| Existing rows need a renamed column and a backfill | Reviewed migration artifact |
| A report must finish after a restart | Native Effect durable execution, composed by the application |

A useful rule: use generated operations when they express the whole intended action. If the operation’s meaning depends on a business decision, write that decision rather than trying to hide it in field annotations.

## One contract, several clients

The CLI, MCP tools, and admin use the application's published operation schemas and handlers. An admin form is not a privileged route. An MCP session is not an identity. Authorization and trusted request subjects must still be provided and enforced.

The HTTP endpoint is **Effect JSON RPC**, not REST. A resource named `books` does not create `/books` routes. Use the generated CLI, an Effect RPC client, or the generated MCP tools rather than inventing HTTP request envelopes.

## Current scope

The repository implements a Bun runtime and SQLite persistence, with example applications that exercise different policies and workflows. It is an experimental workspace, not a promise of stable APIs, other database adapters, or production authentication.

The [examples](/examples) show what you can run now. The [thesis](/wiki/thesis) explains the design direction; the [validation record](/wiki/validation-strategy) distinguishes actual observations from unproven claims.

## Continue

- [Define a resource](/guides/define-a-resource) to build a small application.
- [Restrict access](/guides/authorization) before storing private data.
- [Choose an example](/examples) when your domain needs more than record editing.

Implementation sources: [Resource](../packages/effect-domains/src/resource.ts), [Application](../packages/effect-domains/src/application.ts), [Bun runtime](../packages/effect-domains/src/application-bun.ts).
