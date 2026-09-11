# Resource reference

`Resource.make` derives a SQLite table, policy-enforcing local repository, and selected Effect RPC contracts from one canonical `Schema.Struct`.

## Construction

```ts
import { Schema } from "effect"
import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"

const Books = Resource.make({
  name: "books",
  schema: Schema.Struct({
    title: Schema.NonEmptyString,
    status: Schema.Literals(["planned", "reading", "finished"]),
    notes: Schema.NullOr(Schema.String),
  }),
  authorization: Authorization.public,
  operations: {
    ...Resource.crud,
    patch: true,
    list: { filter: ["status"], order: [["title", "asc"]], limit: 25 },
  },
})
```

| Option | Contract |
| --- | --- |
| `name` | SQLite table name and prefix for generated operation names. |
| `schema` | Canonical flat `Schema.Struct`. Fields need supported SQLite encodings. |
| `authorization` | `Authorization.public`, `Authorization.deny`, or `Authorization.for(...).policy(...)`. |
| `operations` | Selected generated operations and their create/list policies. |
| `storage` | Optional reversible physical `Schema.Struct`; defaults to `schema`. It preserves canonical field names and identity annotations. |
| `relations` | Optional `unique`, `foreignKeys`, and `indexes`; fields are storage fields. |
| `version` | Optional integer version-field name. Create writes `1`; updates and patches require the read version and increment it. |
| `transitions` | Optional `Transitions.make(...)` declaration used by local and published transition operations. |

A resource exposes `table`, `repository`, `group`, and `handlers`. `Application.make({ name, parts })` rejects duplicate table and operation names.

## Operations and repository

`Resource.crud` selects `get`, `list`, `create`, `update`, and `remove`. Add `patch: true` or `transition: true` as needed. `false` omits an RPC; `publish: false` on an object-form `create` or `list` keeps its local policy without publishing it. Repository methods remain available regardless of publication and always enforce authorization.

Published names are `${name}.get`, `${name}.list`, `${name}.create`, `${name}.update`, `${name}.patch`, `${name}.remove`, and `${name}.transition`.

| Method / operation | Input | Result |
| --- | --- | --- |
| `get` / `remove` | `{ [identifier]: key }` | Complete row / `void` |
| `update` | Complete row, including its identifier | Complete row |
| `patch` | `{ key, changes }`, or `{ key, expectedVersion, changes }` with `version` | Complete row |
| `transition` | `{ key, action, changes?, expectedVersion? }` | Complete row |
| `repository.ensure(row)` | Complete row | Inserts if its identifier is absent; otherwise returns the existing read-authorized row. |

`repository.find(key)` is local-only and returns `Option`. `repository.transition(key, action, changes?, expectedVersion?)` checks the declared graph, applies the status change, and uses optimistic version checking when configured. A transition declaration also exposes `apply(action, key)(row)` for a guarded in-memory status change.

A `version` field is not caller-controlled in create or patch changes. A stale mutation fails with `VersionConflict { resource, key, expectedVersion }`. A declared unique constraint can fail with `UniqueViolation { resource, constraint, fields }`; translate that error in an authored operation only when the domain needs a distinct error name.

## Create input

The object form of `create` accepts `defaults`, `generated`, `fromSubject`, and `publish: false`. A field has one source only: caller input, default, generation, or trusted subject binding.

`Schema.NullOr(...)` fields are optional on create and receive `null` when omitted. Do not add `defaults: { field: null }` merely to make a nullable field optional. `generated` supports `"uuidV7"` and `"now"`; `fromSubject` is available with policy authorization and receives typed `p.subject` operands.

## Lists

```ts
operations: {
  list: {
    filter: ["status"],
    range: ["publishedAt"],
    order: [["publishedAt", "desc"]],
    limit: 25,
  },
}
```

A list request accepts `filter?`, `range?`, `limit?`, and `cursor?` and returns `{ items, nextCursor }`.

- `filter` is equality-only and accepts declared fields only.
- `range` accepts declared fields as `{ range: { publishedAt: { from?, to? } } }`; both bounds are inclusive.
- `order` is the declared ordering; the identifier is appended as a stable tiebreaker.
- `limit` is from 1 through the configured maximum (50 by default).
- Return a non-null cursor unchanged with the same filter and range to read the next page.

## Relations and projections

Relation names are optional. `Table` derives them as `<table>_<snake_case fields>_key`, `_fkey`, or `_idx`. A foreign-key `scope` is prepended on both sides, so a tenant-scoped reference can stay concise:

```ts
relations: {
  foreignKeys: [{
    fields: ["orderId"],
    references: { table: "orders", fields: ["id"] },
    scope: ["tenantId"],
  }],
}
```

This creates a foreign key over `(tenantId, orderId)` to `(tenantId, id)`. Keep an explicit relation name only when a frozen migration artifact requires a different name.

`Table.project(table, ["id", "number"])` provides selected `fields`, `schema`, JSON codec, and `object(sql, alias)` for an authored projection. Use it to compose native SQL without restating table fields.

`SqliteView.make` remains the option for a declared joined projection. It supplies a selected row codec, a quoted SQL prefix, columns, and dependency metadata; filtering, grouping, ordering, pagination, authorization, and transaction policy remain authored. See the [repair board](../../examples/repair-workshop/board.ts).

## Errors and limits

Malformed generated payloads, undeclared filters/ranges, invalid limits/cursors, and storage failures surface as `RepositoryError`; absent rows are `ResourceNotFound`. Policy resources additionally surface `Unauthenticated`, `Forbidden`, `EntitlementRequired`, and `EntitlementUnavailable`.

Resource generation covers routine record persistence. Cross-resource invariants, aggregates, custom queries, and external effects belong in authored [`Operation`](../../packages/effect-domains/src/operation.ts) handlers.

## Source

- [`Resource.make`](../../packages/effect-domains/src/resource.ts)
- [`Transitions.make`](../../packages/effect-domains/src/transitions.ts)
- [`Table`](../../packages/effect-domains/src/table.ts)
- [`RepositoryStore` errors](../../packages/effect-domains/src/repository-store.ts)
- [`SqliteView`](../../packages/effect-domains/src/sqlite-view.ts)
