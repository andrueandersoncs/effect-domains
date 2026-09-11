# Resource reference

`Resource.make` derives a SQLite table descriptor, a policy-enforcing local repository, and—only for selected published operations—an Effect RPC group and handlers. It operates on one canonical `Schema.Struct`; it does not create a second transport model.

## Construction

```ts
import { Schema } from "effect"
import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"

const BookSchema = Schema.Struct({
  title: Schema.NonEmptyString,
  status: Schema.Literals(["planned", "reading", "finished"]),
})

const resource = Resource.make({
  name: "books",
  schema: BookSchema,
  authorization: Authorization.public,
  operations: Resource.crud,
  relations: {
    indexes: [{ name: "books_status", fields: ["status"] }],
  },
})
```

| Option | Required | Description |
| --- | --- | --- |
| `name` | yes | Resource/table name and prefix for generated operation names, such as `books.get`. |
| `schema` | yes | Flat canonical `Schema.Struct` for rows and generated request/result codecs. Its fields must have supported scalar storage encodings. |
| `authorization` | yes | `Authorization.public`, `Authorization.deny`, or a policy made with `Authorization.for(...).policy(...)`. Authorization belongs to the resource, not the canonical schema. |
| `operations` | yes | Record selecting published generated operations and their create/list policies. |
| `storage` | no | Physical Struct schema. It must contain exactly the canonical field names and preserve each field's identity annotation; use it only for a reversible storage encoding that differs from the canonical model. Defaults to `schema`. |
| `relations` | no | Table `unique`, `foreignKeys`, and `indexes` declarations. Fields must be storage fields; application composition validates cross-table foreign keys. |

A resource exposes `table`, `repository`, `group`, and `handlers`. `Application.make({ name, parts })` composes resource groups and tables; duplicate resource table names and duplicate operation names are rejected.

## Operations: local repository and publication

The local `repository` always has `find`, `get`, `list`, `create`, `update`, `patch`, and `remove`. Generated RPCs and handler entries are selected separately by `operations`:

```ts
operations: {
  ...Resource.crud,
  patch: true,
  create: { publish: false, defaults: { rating: null } },
  list: { publish: false, filter: ["status"], limit: 25 },
}
```

`Resource.crud` is `{ get: true, list: true, create: true, update: true, remove: true }`. Add `patch: true` to publish patch. Set an operation to `false` to omit its generated RPC. An empty record, `operations: {}`, publishes no generated RPCs while retaining the local repository.

`publish: false` is available in the object forms of `create` and `list`: their defaults, generation, subject bindings, filters, and limit still govern the local repository, but no corresponding RPC is included in `group`. It is not an access-control mechanism. Repository methods enforce the resource's authorization regardless of publication.

Published names are `${name}.get`, `${name}.list`, `${name}.create`, `${name}.update`, `${name}.patch`, and `${name}.remove`. A selected resource is native Effect RPC, not a REST route.

## Create input and result

`create: true` accepts every canonical field other than an implicit identifier. The object form additionally accepts these options:

| Option | Effect on create input and stored candidate |
| --- | --- |
| `defaults` | Named canonical fields become optional in create input. An omitted field receives its configured value; a supplied value still must satisfy its schema. |
| `generated` | Named canonical fields are omitted from create input and filled at runtime with `"uuidV7"` or `"now"`. |
| `fromSubject` | With policy authorization only, maps named fields to typed `p.subject` operands. The fields are omitted from create input and receive trusted subject values. |
| `publish: false` | Retains this create policy locally but omits `name.create` from the RPC group. |

A field may have exactly one source: caller input, `defaults`, `generated`, or `fromSubject`. Configuring the same field in more than one source is invalid. Defaults make a field optional; `Schema.NullOr(...)` makes `null` valid. They are independent: a nullable field with no default is still required in create input, and a default must itself satisfy the canonical schema.

The create result is the complete canonical row. For public resources its declared generated errors are `RepositoryError` and `ResourceNotFound`; policy resources can additionally produce `Unauthenticated`, `Forbidden`, `EntitlementRequired`, and `EntitlementUnavailable`.

## Read, update, remove, and patch contracts

| Operation | RPC payload | Success result | Missing/error behavior |
| --- | --- | --- | --- |
| `get` | `{ [identifier]: key }` | Complete canonical row | Missing row: `ResourceNotFound`. |
| `update` | Complete canonical row, including its identifier | Complete canonical row | Replaces the row value; the complete candidate must satisfy the canonical schema. |
| `remove` | `{ [identifier]: key }` | `void` | Missing row: `ResourceNotFound`. |
| `patch` | `{ key, changes }` | Complete canonical row | `changes` is a partial canonical row and must not contain the identifier. |

`repository.find(key)` is local-only and returns `Option`; `repository.get(key)` is the throwing/not-found variant used by generated get. `repository.patch(key, changes)` takes two arguments; published patch wraps those as `{ key, changes }` so its request does not depend on the identifier field name.

Update replaces the row with the supplied complete value. Patch reads the existing row, merges `changes`, validates the merged complete row, and preserves the identifier. Generated mutations run through the repository transaction boundary; authorization checks apply before writes and the returned row must be readable.

## List

A selected list has this input shape:

```ts
{
  filter?: { /* declared fields only */ },
  limit?: number,
  cursor?: string,
}
```

It always returns:

```ts
{ items: ReadonlyArray<Row>, nextCursor: string | null }
```

Configure a list with `list: { filter: ["status"], limit: 25 }`.

- Filters are equality filters. Only named, declared canonical fields are accepted; an undeclared filter fails.
- `limit` must be an integer from 1 through the configured maximum. Omitting it uses that maximum; the default configuration is 50.
- Rows are ordered by the identifier ascending. Arbitrary ordering and a separate unbounded/page repository operation are not provided.
- Return a non-null `nextCursor` unchanged with the same encoded filter to read the next page. A malformed cursor, a cursor for a different filter, or a cursor without valid pagination identity fails.
- Published lists require an identifier whose storage encoding preserves canonical ordering.

Authorization visibility is applied to repository reads and lists. With a policy, a row outside scope/read visibility is not returned; `Authorization.public` has no identity requirement or row filter.

Entitlement requirements are additional checks, not SQL visibility filters. A page containing a visible row without its required grant fails with `EntitlementRequired`; it is not silently shortened.

## Identifier behavior

If the canonical schema has no field annotated with `identifier` from `effect-domains/domain`, the table adds a persistence identifier named `id`. It is a generated UUIDv7 and appears in returned rows, update input, get/remove requests, and patch `key`; it is not part of the source schema or create input.

```ts
import { identifier } from "effect-domains/domain"

const BookSchema = Schema.Struct({
  isbn: identifier(Schema.String),
  title: Schema.NonEmptyString,
})
```

An intrinsic identifier replaces the implicit `id`. A schema may have at most one intrinsic identifier, it must not be nullable, and callers supply it on create unless the create policy makes it defaulted, generated, or subject-bound. A field named `id` without `identifier(...)` is rejected because it is ambiguous with the implicit key.

## Error boundaries and limits

Resource construction validates operation shapes, storage compatibility, list filter names, subject bindings, table constraints, and policy/storage compatibility. Invalid construction fails as a resource/table/authorization definition error rather than creating a partial resource.

At request time, generated schemas reject malformed payloads. Repository validation, invalid list limits/cursors/filters, and storage or codec failures are surfaced as `RepositoryError`; absent records are `ResourceNotFound`. Policy resources additionally distinguish missing identity (`Unauthenticated`), denied actions (`Forbidden`), and entitlement failures (`EntitlementRequired` or `EntitlementUnavailable`). Do not use `Authorization.public` to avoid these errors: it deliberately removes authentication and authorization checks.

Resource generation stops at routine persistence and CRUD. Business transitions, custom ordering/range queries, retries, idempotency, caching, transaction composition across resources, and a production authentication mechanism remain authored application code.

## Source

- [`Resource.make` and generated operation schemas](../../packages/effect-domains/src/resource.ts)
- [`Creation input compilation`](../../packages/effect-domains/src/resource-creation.ts)
- [`Table` storage and identifier rules](../../packages/effect-domains/src/table.ts)
- [`Authorization` definitions and enforcement](../../packages/effect-domains/src/authorization.ts)
- [`Application` composition](../../packages/effect-domains/src/application.ts)
