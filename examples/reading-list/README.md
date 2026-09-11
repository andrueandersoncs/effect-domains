# Reading list: generated book tracking

[All examples](../README.md)

Add two books, move one from reading to finished, page through the backlog, and remove an entry. This is the smallest example to run before comparing [authored expense queries](../expense-ledger/README.md) or [tenant-scoped tasks](../team-tasks/README.md).

This small public reading list uses one local canonical schema and generated CRUD. A book has a title, author, reading status, format, optional rating, and optional notes; title, author, and notes (when supplied) cannot be empty, and ratings are whole numbers from 1 through 5.

```ts
export const ReadingListResource = Resource.make({
  authorization: Authorization.public,
  name: "books",
  schema: ReadingListBookSchema,
  operations: {
    ...Resource.crud,
    list: { filter: ["status", "format"], limit: 25 },
  },
})
```

The resource derives the `books.create`, `books.get`, `books.list`, `books.update`, and `books.remove` RPCs, table, UUIDv7 identifier, request/result/error schemas, and handlers. There is no authored SQL or custom command layer.

## Run it

Run these commands from the repository root with Bun installed. The build supplies both browser surfaces:

```bash
bun install
bun run build
export READING_LIST_DB="$(mktemp -d)/reading-list.sqlite"
bun run reading-list:server
```

Leave this terminal running. The runner serves a Foldkit reading list at [http://127.0.0.1:3000/](http://127.0.0.1:3000/) and the generated admin at [http://127.0.0.1:3000/admin](http://127.0.0.1:3000/admin). Both use the same published RPC surface as the CLI. No token is required.

## Add books and record progress

In another terminal, create and filter entries:

```bash
bun run reading-list books.create --input-json '{"title":"The Dispossessed","author":"Ursula K. Le Guin","status":"planned","format":"paperback"}'
bun run reading-list books.create --input-json '{"title":"Braiding Sweetgrass","author":"Robin Wall Kimmerer","status":"reading","format":"audiobook","notes":"Listen during walks"}'
bun run reading-list books.list --input-json '{"filter":{"status":"reading"},"limit":10}'
```

Each create returns the complete book with a generated UUIDv7 `id`; omitted `rating` and `notes` become `null`. The filtered page contains “Braiding Sweetgrass”, not “The Dispossessed”. Copy **the second book's** returned `id` and assign it in this client terminal:

```bash
BOOK_ID='paste-the-returned-id-here'
```

Update the complete row, including fields that have not changed:

```bash
bun run reading-list books.update --input-json "{\"id\":\"$BOOK_ID\",\"title\":\"Braiding Sweetgrass\",\"author\":\"Robin Wall Kimmerer\",\"status\":\"finished\",\"format\":\"audiobook\",\"rating\":5,\"notes\":\"Finished during walks\"}"
bun run reading-list books.get --input-json "{\"id\":\"$BOOK_ID\"}"
```

The get result now has `status: "finished"`, `rating: 5`, and the new notes. Create may omit `rating` and `notes`; update requires the complete row. There is no published `books.patch` operation. Status is editable record state, not a guarded transition: the schema also permits moving a finished book back to planned.

The [canonical schema](domain.ts) allows these values:

| Field | Accepted value |
| --- | --- |
| `title`, `author` | Nonempty strings |
| `status` | `planned`, `reading`, `finished` |
| `format` | `paperback`, `hardcover`, `ebook`, `audiobook` |
| `rating` | `null` or a whole number from 1 through 5 |
| `notes` | `null` or a nonempty string |

A rating does not require finished status; the schema imposes no such business rule.

## Page through the list

```bash
bun run reading-list books.list --input-json '{"limit":1}'
```

With the two books above, this returns one item and a non-null `nextCursor`. Copy the cursor string, without its surrounding JSON quotes:

```bash
CURSOR='paste-the-returned-cursor-here'
bun run reading-list books.list --input-json "{\"limit\":1,\"cursor\":\"$CURSOR\"}"
```

The second page contains the other book. Continue until `nextCursor` is `null`; a previously populated database may have more rows. Results are ordered by identifier ascending, not title or status. The configured default **and maximum** page size is 25. Equality filters can use `status`, `format`, or both:

```bash
bun run reading-list books.list --input-json '{"filter":{"status":"finished","format":"audiobook"},"limit":10}'
```

Keep exactly the same filters when reusing a cursor. A cursor from an unfiltered list is not valid for this filtered query. There is no full-text title search or arbitrary sort option. See the [list contract](../../docs/reference/resources.md#list) for cursor validation.

## Try a failure and remove a book

A meaningful validation failure is a rating outside the allowed range:

```bash
bun run reading-list books.create --input-json '{"title":"Example","author":"Author","status":"finished","format":"ebook","rating":6}'
```

This command fails input validation and does not create a book. Empty titles, unknown status values, fractional ratings, and incomplete updates also fail.

Remove the book created in the earlier step:

```bash
bun run reading-list books.remove --input-json "{\"id\":\"$BOOK_ID\"}"
bun run reading-list books.get --input-json "{\"id\":\"$BOOK_ID\"}"
```

Remove has a void result, not a deleted book. The following get exits nonzero with `ResourceNotFound`; repeating remove also fails. Repository/storage errors are reported as `RepositoryError`. “The Dispossessed” remains in the database.

## Use the browser or MCP

At `/`, use **Add a book**, then **Edit**, **Save changes**, or **Remove** on a row. Status and format selectors refresh through the canonical native client and invalidate the prior query. **Reload** fetches current data after CLI changes, and **Load more books** appends a returned cursor page. Form validation, including invalid rating or notes, appears beside the relevant field; saves and removals refresh the list.

The generated admin exposes the same five operations and their schemas. The Streamable HTTP MCP endpoint is `http://127.0.0.1:3000/mcp`; for example, `books.list` accepts `{"input":{"filter":{"status":"planned"}}}` and returns its page under `structuredContent.result`. See [shared MCP conventions](../README.md#mcp-server).

## Runtime and persistence

| Setting | Default | Meaning |
| --- | --- | --- |
| `READING_LIST_DB` | `data/reading-list.sqlite` | SQLite database file |
| `PORT` | `3000` | Loopback HTTP port |
| `READING_LIST_URL` | `http://127.0.0.1:3000/rpc/v1` | CLI RPC endpoint |

The server is unauthenticated and loopback-only. Startup applies [the imported migration history](migrations.ts); it does not reset rows or adopt an untracked database. Stop with Ctrl-C and restart with the same database path, then list books to see that the remaining entry persists. Local inspection does not require a server:

```bash
bun run reading-list inspect books.create
bun run reading-list --help
```

This is a public local register, not a private account service: there is no login, per-reader ownership, reading-history ledger, or concurrent-edit version check.

## OpenTelemetry traces

The runner already installs Effect OTLP tracing. Export starts when a collector endpoint is set. This example names the service `reading-list` and marks `deployment.environment.name=local`.

With a Jaeger all-in-one on loopback `4318` (UI [http://127.0.0.1:16686](http://127.0.0.1:16686/)):

```bash
bun run reading-list:server:otel
```

In another terminal:

```bash
bun run reading-list:otel books.create --input-json '{"title":"The Dispossessed","author":"Ursula K. Le Guin","status":"planned","format":"paperback"}'
bun run reading-list:otel books.list --input-json '{"filter":{"status":"planned"},"limit":10}'
```

Set the endpoint on both processes so CLI and server share a trace. In Jaeger, search service `reading-list`. No endpoint means no collector traffic; omit the `:otel` scripts for that.


## Code map

- [`domain.ts`](domain.ts): local reading-list canonical schema.
- [`resources.ts`](resources.ts): generated CRUD and list policy.
- [`application.ts`](application.ts): resource registration.
- [`main.ts`](main.ts): Bun runner and generated admin.
- [`migrations.ts`](migrations.ts) and [artifacts](migrations/): frozen persistence history.
- [`web/main.ts`](web/main.ts): authored Foldkit form, filters, and single-page list.

For the underlying derivation boundary, read [how the pieces fit](../../docs/concepts.md). For shared command, transport, and telemetry options, use the [runtime reference](../../docs/reference/runtime.md).
