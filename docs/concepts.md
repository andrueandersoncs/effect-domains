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

A resource specification combines a canonical schema with authorization, declared capabilities, creation sources, list declarations, optional storage, relations, a version field, and a transition graph. `Resource.define` records that intent; `Resource.compile` derives its table, local repository, RPC contracts, and handlers.

A nullable field defaults to `null` when omitted on create. A version field gives patches `{ key, expectedVersion, changes }` and produces `VersionConflict` for stale writes. `Resource.list(...)` can expose equality filters, inclusive ranges, and stable declared order. `Resource.repository(spec).ensure(row)` is the idempotent seed primitive; declared unique constraints surface `UniqueViolation`.

`Transitions.make` declares allowed status actions. Passing it to `Resource.define` and including `Resource.transition()` publishes the transition contract; local code uses `Resource.repository(spec).transition(...)`.

A **repository** is the local Effect interface to stored rows. A **published command** is an RPC contract with input, success, and error schemas. Capability publication and authorization are separate.

See the [resource reference](/reference/resources) for exact contracts.

## Authored business commands

Use `Command.define` for an inspectable command contract and `Command.implement` to attach authored behavior. A command family binds a shared namespace, unavailable boundary, authorization policy, and transaction mode without putting procedures into the specification.

```ts
import { Effect, Schema } from "effect"
import { Command } from "effect-domains/command"

class BillingUnavailable extends Schema.TaggedError<BillingUnavailable>()(
  "BillingUnavailable",
  {},
) {}

const BillingCommand = Command
  .family("billing.", BillingUnavailable)
  .transactional()

const issueInvoiceSpec = BillingCommand.define({
  name: "issueInvoice",
  payload: Schema.Struct({ orderId: Schema.String }),
  success: Schema.Struct({ invoiceId: Schema.String }),
})

const issueInvoice = Command.implement(
  issueInvoiceSpec,
  (input) => Effect.succeed({ invoiceId: input.orderId }),
)

export const BillingCommands = Command.bundle(issueInvoice)
```

Compilation applies JSON codecs and derives the public error schema from declared domain errors plus the required unavailable schema. Undeclared infrastructure failures become unavailable failures; omitted domain-tagged errors are rejected at compile time. Dependencies accept Resource, Table, and ReadModel specifications, and application composition validates their exact registered tables.

Use an authored operation when an action preserves a cross-record invariant, calculates an aggregate, invokes an external system, or has a domain-specific failure boundary. For example, reservations can use declared state transitions while their inventory accounting remains an authored transactional operation.

## Application: which operations belong together

`Application.define({ name, parts })` records explicit `Part.resource`, `Part.command`, `Part.native`, `Part.featureFlag`, and `Part.application` syntax. `Application.compile` produces the authoritative `ApplicationIR`, recursively flattens nested applications, and rejects duplicate tables, commands, and feature-flag names across the complete tree. Orders and invoices keeps its billing resources and commands together while the outer runnable application adds native identity. Support cases composes directory and case-management siblings whose relations and command dependencies cross the child boundary.

```text
ResourceSpec ──Resource.compile────┐
CommandSpec + implementation ─────┼─Application.compile─► ApplicationIR
ReadModel syntax ──fold────────────┤                         ├── HTTP RPC / CLI
FeatureFlag declaration ──────────┘                         ├── MCP tools
                                                          ├── inspection
                                                          └── Application UI
```

Feature flags remain application-level operational declarations. The compiled IR retains their names, defaults, and descriptions for inspection; a supplied `FeatureFlags` service owns live state. See [feature flags](/reference/runtime#feature-flags) for the memory implementation and explicit persistence/targeting boundary.


`ApplicationBun.run(application, options)` supplies SQLite history, application services, initialization, background layers, and the command Effect; pass it to the re-exported `ApplicationBun.runMain` boundary in a Bun entrypoint. See [runtime and clients](/reference/runtime).

## One contract, several clients

The CLI, MCP tools, and generated Application UI interpret the same published operation schemas and handlers. A generated form is not a privileged route, an MCP session is not an identity, and the browser does not invent a second RPC envelope. HTTP is Effect JSON RPC, not REST.

## Current scope

The repository implements a Bun runtime and SQLite persistence. It is experimental, not a promise of stable APIs, other database adapters, or production authentication.

## Continue

- [Define a resource](/guides/define-a-resource)
- [Restrict access](/guides/authorization)
- [Choose an example](/examples)

Implementation sources: [`Resource`](../packages/effect-domains/src/resource.ts), [`Command`](../packages/effect-domains/src/command.ts), [`ReadModel`](../packages/effect-domains/src/read-model.ts), [`Application`](../packages/effect-domains/src/application.ts), and [Bun runtime](../packages/effect-domains/src/application-bun.ts).
