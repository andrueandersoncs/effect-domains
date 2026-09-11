---
description: Understand schemas, resources, applications, and the boundary between generated operations and business rules.
---

# How the pieces fit

Effect Domains removes repeated descriptions of data. It does not derive an entire application from a record type.

## Schema: what a value means

A canonical schema describes application data: field types, allowed statuses, and valid ranges. It is the representation application code uses, rather than SQLite's storage encoding.

Use domain value schemas instead of restating common constraints: `UuidV7Schema`, `SafeIntSchema`, `NonNegativeSafeIntSchema`, `PositiveSafeIntSchema`, and `PageLimitSchema`. Use `Schema.DateTimeUtc` for canonical timestamps. Brands compose normally—for example, `pipe(UuidV7Schema, Schema.brand("OrderId"))`.

A rating between 1 and 5 belongs in the schema. A SQLite index name, a user's permissions, and the label on an admin form do not. An explicit storage codec is appropriate when storage differs reversibly from the canonical value, as in the [field-notes encryption codec](../examples/field-notes/storage.ts).

## Resource: records and routine operations

A resource combines a canonical schema with authorization, selected CRUD operations, creation sources, list declarations, optional storage, relations, a version field, and a transition graph. It derives a table, local repository, and selected RPC contracts and handlers.

A nullable field defaults to `null` when omitted on create. A version field gives patches `{ key, expectedVersion, changes }` and produces `VersionConflict` for stale writes. Declared lists can expose equality filters, inclusive ranges, and a stable declared order. `repository.ensure(row)` is the idempotent seed primitive; declared unique constraints surface `UniqueViolation` rather than requiring preflight reads.

`Transitions.make` declares allowed status actions. Passing it as `Resource.make({ transitions })` and selecting `transition: true` publishes the resource transition contract; local code uses `repository.transition(...)`. This fits state changes that remain a single record mutation.

A **repository** is the local Effect interface to stored rows. An **RPC operation** is a published contract with input, success, and error schemas. Publication and authorization are separate: omitting an operation does not authorize a local repository call.

See the [resource reference](/reference/resources) for exact contracts.

## Authored operations: business commands

Use `Operation.make` for an authored application operation instead of assembling `Rpc.make`, a group, a handler layer, authorization middleware, and error translation by hand.

```ts
import { Effect, Schema } from "effect"
import { Operation } from "effect-domains/operation"

class BillingUnavailable extends Schema.TaggedError<BillingUnavailable>()(
  "BillingUnavailable",
  {},
) {}

const issueInvoice = Operation.make({
  name: "billing.issueInvoice",
  payload: Schema.Struct({ orderId: Schema.String }),
  success: Schema.Struct({ invoiceId: Schema.String }),
  error: BillingUnavailable,
  unavailable: BillingUnavailable,
  handler: (input) => Effect.succeed({ invoiceId: input.orderId }),
})

export const BillingOperations = Operation.bundle(issueInvoice)
```

`Operation.make` takes one definition with a `name`, JSON-codecs its payload, success, and error schemas, and translates undeclared infrastructure or untagged failures to `unavailable`; a domain-tagged failure the handler can raise but `error` omits is a compile error, so nothing a client should see is silently hidden. With a `SubjectPolicy`, its handler also receives a typed subject; `transaction: true` wraps it in `RepositoryStore.transaction`, and `views` records `SqliteView` dependencies.

Use an authored operation when an action preserves a cross-record invariant, calculates an aggregate, invokes an external system, or has a domain-specific failure boundary. For example, reservations can use declared state transitions while their inventory accounting remains an authored transactional operation.

## Application: which operations belong together

`Application.make({ name, parts })` composes resources, `Operation.bundle(...)` values, `IdentityBundle`, and nested applications. It rejects duplicate tables and operation names.

```text
Canonical schema + resource configuration
    ├── SQLite table and repository
    └── Selected RPC contracts and handlers
                │
Operation.bundle ┤
                ▼
           Application
                ├── HTTP RPC → generated CLI
                ├── MCP tools
                └── Optional browser admin
```

`ApplicationBun.run(application, options)` supplies SQLite history, application services, initialization, background layers, and the command Effect; pass it to `BunRuntime.runMain` in a Bun entrypoint. See [runtime and clients](/reference/runtime).

## One contract, several clients

The CLI, MCP tools, generated admin, and example Foldkit pages use the published operation schemas and handlers. An admin form is not a privileged route, an MCP session is not an identity, and browser pages do not invent a second RPC envelope. HTTP is Effect JSON RPC, not REST.

## Current scope

The repository implements a Bun runtime and SQLite persistence. It is experimental, not a promise of stable APIs, other database adapters, or production authentication.

## Continue

- [Define a resource](/guides/define-a-resource)
- [Restrict access](/guides/authorization)
- [Choose an example](/examples)

Implementation sources: [`Resource`](../packages/effect-domains/src/resource.ts), [`Operation`](../packages/effect-domains/src/operation.ts), [`Application`](../packages/effect-domains/src/application.ts), and [Bun runtime](../packages/effect-domains/src/application-bun.ts).
