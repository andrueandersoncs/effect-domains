# Resource reference

`Resource.define` records canonical resource intent. `Resource.compile` mechanically derives the SQLite table, policy-enforcing repository, and selected Effect RPC contracts.

## Construction

```ts
import { Schema } from "effect"
import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { Table } from "effect-domains/table"

const Books = Resource.define({
  name: "books",
  schema: Schema.Struct({
    title: Schema.NonEmptyString,
    status: Schema.Literals(["planned", "reading", "finished"]),
    notes: Schema.NullOr(Schema.String),
  }),
  authorization: Authorization.public,
  capabilities: Resource.capabilities(
    Resource.get(),
    Resource.list({ filter: ["status"], order: [["title", "asc"]], limit: 25 }),
    Resource.create(),
    Resource.update(),
    Resource.remove(),
    Resource.patch(),
  ),
})
```

| Option | Contract |
| --- | --- |
| `name` | SQLite table name and prefix for generated operation names. |
| `schema` | Canonical flat `Schema.Struct`. Fields need supported SQLite encodings. |
| `authorization` | `Authorization.public`, `Authorization.deny`, or `Authorization.for(...).policy(...)`. |
| `capabilities` | Closed capability syntax selecting publication and create/list policy. |
| `storage` | Optional reversible physical `Schema.Struct`; defaults to `schema`. It preserves canonical field names and identity annotations. |
| `relations` | Optional `unique`, `foreignKeys`, and `indexes`; fields are storage fields. |
| `version` | Optional integer version-field name. Create writes `1`; updates and patches require the read version and increment it. |
| `transitions` | Optional `Transitions.make(...)` declaration used by local and published transition operations. |

The specification exposes author declarations only. `Resource.compile(Books)` returns the complete runtime IR. Narrow helpers expose individual products: `Resource.table(Books)`, `Resource.repository(Books)`, `Resource.contracts(Books)`, `Resource.group(Books)`, `Resource.handlers(Books)`, and `Resource.published(Books)`. `Application.compile(...)` rejects duplicate table and command names.

## Capabilities and repository

`Resource.crud()` declares `get`, `list`, `create`, `update`, and `remove`. Compose a custom set with `Resource.capabilities(...)`; add `Resource.patch()` or `Resource.transition()` explicitly. `{ publish: false }` on `Resource.create` or `Resource.list` retains its local policy without publishing it. Repository methods remain available regardless of publication and always enforce authorization.

Published names are `${name}.get`, `${name}.list`, `${name}.create`, `${name}.update`, `${name}.patch`, `${name}.remove`, and `${name}.transition`.

| Method / operation | Input | Result |
| --- | --- | --- |
| `get` / `remove` | `{ [identifier]: key }` | Complete row / `void` |
| `update` | Complete row, including its identifier | Complete row |
| `patch` | `{ key, changes }`, or `{ key, expectedVersion, changes }` with `version` | Complete row |
| `transition` | `{ key, action, changes? }`, or `{ key, action, expectedVersion, changes? }` with `version` | Complete row |
| `repository.ensure(row)` | Complete row | Inserts if its identifier is absent; otherwise returns the existing read-authorized row. |

`repository.find(key)` is local-only and returns `Option`. `repository.transition(key, action, changes?, expectedVersion?)` checks the declared graph, applies the status change, and uses optimistic version checking when configured. A transition declaration also exposes `apply(action, key)(row)` for a guarded in-memory status change. Policy resources authorize transition through the distinct `allow.transition` rule, with current and candidate values; patch permission never grants transition permission.

A `version` field is not caller-controlled in create or patch changes. A stale mutation fails with `VersionConflict { resource, key, expectedVersion }`. A declared unique constraint can fail with `UniqueViolation { resource, constraint, fields }`; translate that error in an authored operation only when the domain needs a distinct error name.

## Create input

`Resource.create({ sources })` assigns at most one source to each field: `Resource.defaultValue(value)`, `Resource.generated("uuidV7" | "now")`, or `Resource.fromSubject(operand)`. Unassigned required fields remain caller input.

`Schema.NullOr(...)` fields receive an implicit `null` source when otherwise unassigned. Subject-derived fields require policy authorization and typed subject operands. The compiler rejects incompatible source values and duplicate or forbidden identity control.

## Lists

```ts
const capabilities = Resource.capabilities(
  Resource.list({
    filter: ["status"],
    range: ["publishedAt"],
    order: [["publishedAt", "desc"]],
    limit: 25,
  }),
)
```

A list request accepts `filter?`, `range?`, `limit?`, and `cursor?` and returns `{ items, nextCursor }`. Import `Page` from `effect-domains/page` for authored paged contracts, or use `Resource.contracts(Books).list.successSchema` for a generated list.

- `filter` is equality-only and accepts declared fields only.
- `range` accepts declared fields as `{ range: { publishedAt: { from?, to? } } }`; both bounds are inclusive.
- `order` is the declared ordering; the identifier is appended as a stable tiebreaker.
- `limit` is from 1 through the configured maximum (50 by default).
- Return a non-null cursor unchanged with the same filter and range to read the next page.

`ResourcePager.make(key)` composes a `Page` with keyed `Requests` ownership. It derives replacement/continuation starts, rejects paging past the end or while the key is pending, ignores stale replies, and settles accepted pages. It does not infer filters, authentication, or mutation refresh policy.

## Relations and projections

Relation names are optional. `Table` derives them as `<table>_<snake_case fields>_key`, `_fkey`, or `_idx`. A foreign-key `scope` is prepended on both sides, so a tenant-scoped reference can stay concise:

```ts
relations: {
  foreignKeys: [{
    fields: ["orderId"],
    references: Resource.reference(OrdersResource, ["id"]),
    scope: ["tenantId"],
  }],
}
```

This creates a foreign key over `(tenantId, orderId)` to `(tenantId, id)`. Keep an explicit relation name only when a frozen migration artifact requires a different name.

`Table.project(table, ["id", "number"])` provides selected `fields`, `schema`, JSON codec, and `object(sql, alias)` for an authored projection. Use it to compose native SQL without restating table fields.

`ReadModel.define` declares source resources, explicit inner/left joins, and recursive schema-backed selection syntax. `ReadModel.page` adds bounded equality/range/keyset policy. `ReadModel.compile`, `ReadModel.compilePage`, and `ReadModel.publish` are separate interpretations of the same syntax: row codec/SQL metadata, executable page IR, and a publishable command. Ordering and range fields must preserve non-null storage ordering; authorization and transaction policy remain explicit. See the [repair board](../../examples/repair-workshop/board.ts).

## Errors and limits

Malformed generated payloads, undeclared filters/ranges, invalid limits/cursors, and storage failures surface as `RepositoryError`; absent rows are `ResourceNotFound`. Policy resources additionally surface `Unauthenticated`, `Forbidden`, `EntitlementRequired`, and `EntitlementUnavailable`.

Resource generation covers routine record persistence. Cross-resource invariants, aggregates, custom queries, and external effects belong in authored [`Command`](../../packages/effect-domains/src/command.ts) implementations.

## Source

- [`Resource`](../../packages/effect-domains/src/resource.ts)
- [`Command`](../../packages/effect-domains/src/command.ts)
- [`ReadModel`](../../packages/effect-domains/src/read-model.ts)
- [`Transitions.make`](../../packages/effect-domains/src/transitions.ts)
- [`Table`](../../packages/effect-domains/src/table.ts)
- [`RepositoryStore` errors](../../packages/effect-domains/src/repository-store.ts)
