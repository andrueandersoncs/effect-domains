# Basic CRUD: generated book operations

The smallest CRUD application declares its book schema and selects the standard operations:

```ts
export const BookResource = Resource.make({
  name: "books",
  schema: BookSchema,
  operations: Resource.crud,
})
```

The resource derives the table, UUIDv7 identifier, request/result/error schemas, JSON codecs, RPC group, and handlers. There is no `contracts.ts`, authored SQL, command service, authored service layer, or initialization effect.

For custom SQL and public error/result contracts, see the [authored SQL guide](../README.md#authored-sql). For defaults, pagination, and patch policy, see [resource-crud](../resource-crud/README.md).

## Run it

From the repository root, start the server:

```bash
bun run basic-crud:server
```

The runner also enables the generated admin at [http://127.0.0.1:3000/admin](http://127.0.0.1:3000/admin). It is an opt-in browser surface over the same published RPCs; see the [shared admin guide](../README.md#generated-admin) for bearer entry, forms, JSON fallback, and browser-origin boundaries.

In another terminal:

```bash
bun run basic-crud books.create --title "A Field Guide" --page-count 120
bun run basic-crud books.list
```

Copy the returned UUIDv7 identifier into `BOOK_ID`:

```bash
bun run basic-crud books.get --id "$BOOK_ID"
bun run basic-crud books.update --input-json "{\"id\":\"$BOOK_ID\",\"title\":\"A Revised Field Guide\",\"pageCount\":144}"
bun run basic-crud books.remove --id "$BOOK_ID"
```

Create accepts `title` and `pageCount`; the runtime generates `id`. Update accepts the complete row. List returns an array without pagination because no list policy is declared. Remove returns `void`, not the deleted row. Missing rows report `ResourceNotFound`; persistence and codec failures report `RepositoryError`.

## Runtime and persistence

| Setting | Default | Meaning |
| --- | --- | --- |
| `BASIC_CRUD_DB` | `basic-crud.sqlite` | SQLite database file |
| `PORT` | `3000` | Loopback HTTP port |
| `BASIC_CRUD_URL` | `http://127.0.0.1:3000/rpc/v1` | CLI RPC endpoint |

The server is unauthenticated and loopback-only, using Effect JSON RPC rather than REST. Startup applies frozen migration history without resetting rows or adopting an untracked database. For shared runtime and migration conventions, see the [examples overview](../README.md).

Local commands do not require a server:

```bash
bun run basic-crud inspect books.create
bun run basic-crud schema generate add-field
```

Review migrations; do not regenerate already-applied artifacts from current models.

## Code map

- [`BookSchema`](../../packages/example-support/src/book.ts): canonical book schema shared with authored SQL.
- [`resources.ts`](resources.ts): one generated CRUD declaration.
- [`application.ts`](application.ts): resource registration, with no authored commands.
- [`main.ts`](main.ts): `ApplicationBun.runMain` with a URL manifest and optional runtime settings omitted.
- [`migrations/manifest.json`](migrations/manifest.json) and [artifacts](migrations/): frozen runtime history.
