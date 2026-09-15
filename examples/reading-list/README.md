# Reading list: contract-derived book editor

[All examples](../README.md)

Add two books, move one from reading to finished, page through the backlog, and remove an entry. This is the smallest example to run before comparing [authored expense queries](../expense-ledger/README.md) or [tenant-scoped tasks](../team-tasks/README.md).

This small public reading list uses one local canonical schema and generated CRUD. A book has a title, author, reading status, format, optional rating, and optional notes; title, author, and notes (when supplied) cannot be empty, and ratings are whole numbers from 1 through 5.

```ts
export const ReadingListResource = Resource.define({
  authorization: Authorization.public,
  name: "books",
  schema: ReadingListBookSchema,
  capabilities: Resource.capabilities(
    Resource.get(),
    Resource.list({ filter: ["status", "format"], limit: 25 }),
    Resource.create(),
    Resource.update(),
    Resource.remove(),
  ),
})
```

The specification is author intent only. `Resource.compile` derives the five `books.*` RPCs, table, UUIDv7 identifier, schemas, repository, and handlers; the application compiler contributes those products to one `ApplicationIR`.

The generated Application UI consumes that `ApplicationIR` directly. Inspection supplies the five operations, nullable input shapes, `status` and `format` filters, and cursor-page contract. The example supplies only display title and description in `main.ts`; it has no resource-specific browser state machine or form codec.

## Run it

Run these commands from the repository root with Bun installed. The build prepares the shared Application UI:

```bash
bun install
bun run build
export READING_LIST_DB="$(mktemp -d)/reading-list.sqlite"
bun run reading-list:server
```

Leave this terminal running. The runner serves the generated Application UI at [http://127.0.0.1:3000/](http://127.0.0.1:3000/). It uses the same published operations as CLI and MCP. No token is required.

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

## Use the Application UI or MCP

At `/`, select the Books resource to list rows with declared status/format filters and cursor navigation. Select an operation to run generated create, get, update, patch, or remove forms; complete JSON input remains available for the full canonical payload.

The Streamable HTTP MCP endpoint is `http://127.0.0.1:3000/mcp`; for example, `books.list` accepts `{"input":{"filter":{"status":"planned"}}}` and returns its page under `structuredContent.result`. See [shared MCP conventions](../README.md#mcp-server).

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

## Full-stack OpenTelemetry

Start the pinned local Collector, Tempo, Prometheus, Loki, and Grafana stack:

```bash
bun run observability:up
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:14318 bun run reading-list:server
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000/) and create or list a book. The server exports OTLP traces, metrics, and correlated logs as service `reading-list`; the generated browser exports as `reading-list-browser` through the same-origin `/otel` gateway. Collector credentials and URLs never enter the document. CLI operations use the same configuration:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:14318 \
  bun run reading-list books.list --input-json '{"filter":{"status":"planned"},"limit":10}'
```

Grafana is at [http://127.0.0.1:3001](http://127.0.0.1:3001/). No endpoint means no runtime-owned exporter or browser gateway traffic. Stop the stack with `bun run observability:down`.

## Code map

- [`domain.ts`](domain.ts): local reading-list canonical schema.
- [`resources.ts`](resources.ts): generated CRUD and list policy.
- [`application.ts`](application.ts): resource registration.
- [`main.ts`](main.ts): Bun runner and Application UI presentation.
- [`migrations.ts`](migrations.ts) and [artifacts](migrations/): frozen persistence history.

For the underlying derivation boundary, read [how the pieces fit](../../docs/concepts.md). For shared command, transport, and telemetry options, use the [runtime reference](../../docs/reference/runtime.md).
