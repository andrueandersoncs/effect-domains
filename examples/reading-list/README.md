# Reading list: generated book tracking

This small public reading list uses one local canonical schema and generated CRUD. A book has a title, author, reading status, format, optional rating, and optional notes; title, author, and notes (when supplied) cannot be empty, and ratings are whole numbers from 1 through 5.

```ts
export const ReadingListResource = Resource.make({
  authorization: Authorization.public,
  name: "books",
  schema: ReadingListBookSchema,
  operations: {
    ...Resource.crud,
    create: { defaults: { rating: null, notes: null } },
    list: { filter: ["status", "format"], limit: 25 },
  },
})
```

The resource derives the `books.create`, `books.get`, `books.list`, `books.update`, and `books.remove` RPCs, table, UUIDv7 identifier, request/result/error schemas, and handlers. There is no authored SQL or custom command layer.

## Run it

From the repository root, start the server:

```bash
bun run reading-list:server
```

The runner serves a Foldkit reading list at [http://127.0.0.1:3000/](http://127.0.0.1:3000/) and the generated admin at [http://127.0.0.1:3000/admin](http://127.0.0.1:3000/admin). Both use the same published RPC surface as the CLI. Build frontend and admin assets first with `bun run build`.

In another terminal, create and filter entries:

```bash
bun run reading-list books.create --input-json '{"title":"The Dispossessed","author":"Ursula K. Le Guin","status":"planned","format":"paperback"}'
bun run reading-list books.create --input-json '{"title":"Braiding Sweetgrass","author":"Robin Wall Kimmerer","status":"reading","format":"audiobook","notes":"Listen during walks"}'
bun run reading-list books.list --input-json '{"filter":{"status":"reading"},"limit":10}'
```

Copy a returned UUIDv7 `id` into `BOOK_ID`, then update the complete row:

```bash
bun run reading-list books.update --input-json "{\"id\":\"$BOOK_ID\",\"title\":\"Braiding Sweetgrass\",\"author\":\"Robin Wall Kimmerer\",\"status\":\"finished\",\"format\":\"audiobook\",\"rating\":5,\"notes\":\"Finished during walks\"}"
bun run reading-list books.get --input-json "{\"id\":\"$BOOK_ID\"}"
bun run reading-list books.remove --input-json "{\"id\":\"$BOOK_ID\"}"
```

Create may omit `rating` and `notes`, which default to `null`; update requires the complete row. List returns a bounded `{ items, nextCursor }` page, with an identifier-ascending order, and accepts equality filters for `status` and `format`. Missing rows report `ResourceNotFound`; schema and persistence failures report `RepositoryError`.

A meaningful validation failure is a rating outside the allowed range:

```bash
bun run reading-list books.create --input-json '{"title":"Example","author":"Author","status":"finished","format":"ebook","rating":6}'
```

## Runtime and persistence

| Setting | Default | Meaning |
| --- | --- | --- |
| `READING_LIST_DB` | `reading-list.sqlite` | SQLite database file |
| `PORT` | `3000` | Loopback HTTP port |
| `READING_LIST_URL` | `http://127.0.0.1:3000/rpc/v1` | CLI RPC endpoint |

The server is unauthenticated and loopback-only. Startup applies the frozen imported migration history; it does not reset rows or adopt an untracked database. Local inspection does not require a server:

```bash
bun run reading-list inspect books.create
```

## Code map

- [`domain.ts`](domain.ts): local reading-list canonical schema.
- [`resources.ts`](resources.ts): generated CRUD and list policy.
- [`application.ts`](application.ts): resource registration.
- [`main.ts`](main.ts): Bun runner and generated admin.
- [`migrations.ts`](migrations.ts) and [artifacts](migrations/): frozen persistence history.
