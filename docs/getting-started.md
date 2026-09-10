# Getting Started

Work from the root of this private Bun workspace. The smallest application is a personal **reading list**: keep a backlog, record reading progress, filter by format, and save ratings and notes. It uses generated resource operations without pretending that routine record editing needs a business workflow.

## Install and prebuild

```bash
bun install
bun run build
```

The build precompiles the optional browser admin. Runtime serves those assets rather than compiling a browser application on startup.

## Run the reading-list server

```bash
bun run reading-list:server
```

The server listens on `http://127.0.0.1:3000`, with RPC at `/rpc/v1`, MCP at `/mcp`, and admin at `/admin`. SQLite defaults to `reading-list.sqlite`; startup applies frozen migration history without resetting rows.

The [canonical schema](../examples/reading-list/domain.ts) describes a book's title, author, reading status, format, nullable one-to-five rating, and nullable notes. The [resource declaration](../examples/reading-list/resources.ts) is the complete routine implementation:

```ts
import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ReadingListBookSchema } from "./domain.ts"

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

[Application composition](../examples/reading-list/application.ts) and the [Bun entrypoint](../examples/reading-list/main.ts) provide persistence and transports. There are no hand-written CRUD handlers or duplicate wire models.

## Keep a reading backlog

In another terminal:

```bash
bun run reading-list books.create --input-json '{"title":"A Wizard of Earthsea","author":"Ursula K. Le Guin","status":"planned","format":"paperback"}'
bun run reading-list books.list --input-json '{"filter":{"status":"planned"}}'
```

Creation returns a generated UUIDv7 `id` and defaults `rating` and `notes` to null. Copy the identifier into `BOOK_ID`, then record progress with the complete row:

```bash
bun run reading-list books.update --input-json "{\"id\":\"$BOOK_ID\",\"title\":\"A Wizard of Earthsea\",\"author\":\"Ursula K. Le Guin\",\"status\":\"finished\",\"format\":\"paperback\",\"rating\":5,\"notes\":\"Revisit the balance of names and power\"}"
bun run reading-list books.get --input-json "{\"id\":\"$BOOK_ID\"}"
```

Lists return `{ items, nextCursor }`, order by identifier ascending, and default to 25 items. Pass a non-null cursor back unchanged with the same filters for another page. Invalid statuses and ratings outside one through five are rejected.

This is a public, local personal list—not a lending library, a multi-user reading service, or a publication catalog. See the [reading-list guide](../examples/reading-list/README.md) for removal, errors, and configuration.

## Open the admin surface

Open [http://127.0.0.1:3000/admin](http://127.0.0.1:3000/admin). Forms and lists use the same published operations as the CLI; there is no separate admin contract or permission bypass.

## Inspect contracts and author migrations

Inspection is local and needs no server:

```bash
bun run reading-list inspect books.create
```

There are no schema CLI commands. Author reviewed changes with `SqliteMigrations.make({ id, from, to, steps })`; use `initial({ id, tables })` for fresh creation. Append frozen artifacts and ordered imports decoded by `SqliteMigrations.decodeHistory`. Never regenerate already-applied history from current models. The [migration authoring walkthrough](../examples/README.md#review-schema-changes) includes a runnable draft.

## Try another domain

The [application guide](../examples/README.md) progresses from generated records to expense reports, scoped project tasks, encrypted field notes, editorial planning, equipment tools, stock reservations, billing, and durable report and notification delivery.

- [Thesis](/wiki/thesis) — the derivation boundary.
- [Tables and Queries](/wiki/tables-and-queries) — the implemented resource and runtime contract.
- [Research Agenda](/wiki/research-agenda) — scope and open questions.
- [Validation Strategy](/wiki/validation-strategy) — exercised evidence and its limits.
