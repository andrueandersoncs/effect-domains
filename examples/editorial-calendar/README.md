# Editorial calendar

This planning application tracks articles before publication. It deliberately has no publishing, approval, delivery, or scheduling workflow: the generated CRUD operations only record editorial plans.

It also demonstrates an honest historical upgrade. Version one stored draft `documents` with a `title`. The frozen second artifact renamed that column to `heading`, added nullable `summary`, and backfilled required `priority` with `0`. The frozen third artifact retained the records while removing an old physical string check. The fourth artifact keeps the physical `documents` table and explicitly backfills editorial `channel: "website"`; the newly nullable `plannedPublicationAt` remains `null`.

## Run the historical upgrade

Use the same fresh SQLite path for both commands. The seed program prepares only the frozen version-one `documents` table. The server then applies the entire checked-in history.

```bash
EDITORIAL_CALENDAR_DB=editorial-calendar-demo.sqlite bun run editorial-calendar:seed-v1
EDITORIAL_CALENDAR_DB=editorial-calendar-demo.sqlite bun run editorial-calendar:server
```

In another terminal, inspect the upgraded article and create a planned article:

```bash
EDITORIAL_CALENDAR_URL=http://127.0.0.1:3000/rpc/v1 bun run editorial-calendar documents.list
EDITORIAL_CALENDAR_URL=http://127.0.0.1:3000/rpc/v1 bun run editorial-calendar documents.create --input-json '{"heading":"Trail conditions for October","summary":"A practical weekend guide.","priority":2,"channel":"newsletter","plannedPublicationAt":"2026-10-01T09:00:00.000Z"}'
```

The seeded `Autumn trail guide` retains its UUIDv7 identifier and becomes an article with `heading: "Autumn trail guide"`, `summary: null`, `priority: 0`, `channel: "website"`, and `plannedPublicationAt: null`. Copy a returned identifier into `ARTICLE_ID` for the other generated operations:

```bash
bun run editorial-calendar documents.get --input-json "{\"id\":\"$ARTICLE_ID\"}"
bun run editorial-calendar documents.update --input-json "{\"id\":\"$ARTICLE_ID\",\"heading\":\"Trail conditions for October\",\"summary\":\"Updated for the newsletter.\",\"priority\":1,\"channel\":\"newsletter\",\"plannedPublicationAt\":\"2026-10-02T09:00:00.000Z\"}"
bun run editorial-calendar documents.remove --input-json "{\"id\":\"$ARTICLE_ID\"}"
bun run editorial-calendar inspect documents.create
```

Starting the server with a fresh database applies the complete history without inserting the historical row. The seed program intentionally fails against an already upgraded database rather than trying to insert an obsolete document.

| Setting | Default | Meaning |
| --- | --- | --- |
| `EDITORIAL_CALENDAR_DB` | `editorial-calendar.sqlite` | SQLite database for the seed program and server |
| `EDITORIAL_CALENDAR_URL` | `http://127.0.0.1:3000/rpc/v1` | RPC endpoint for the generated CLI |
| `PORT` | `3000` | Loopback server port |

## Current model and history boundary

`DocumentsResource` declares generated `documents.get`, `documents.list`, `documents.create`, `documents.update`, and `documents.remove` for article planning records. Article creation requires a non-empty heading, nullable summary, non-negative integer priority, a `website`, `newsletter`, or `print` channel, and a nullable ISO publication timestamp. Updates require the complete stored row. List returns `{ items, nextCursor }`, uses a limit of 50 by default, and orders by UUIDv7 identifier ascending.

The history remains authored and immutable:

- [`legacy.ts`](legacy.ts) is the isolated version-one `documents` schema used only by [`seed-v1.ts`](seed-v1.ts).
- [`001_initial`](migrations/001_initial.json), [`002_document_metadata`](migrations/002_document_metadata.json), and [`003_schema_string_checks`](migrations/003_schema_string_checks.json) are frozen historical artifacts.
- [`004_editorial_metadata`](migrations/004_editorial_metadata.json) is the reviewed editorial-metadata migration. Its same-table rebuild copies `id`, `heading`, `summary`, and `priority`, supplies the `website` channel, and relies on the nullable target column for `plannedPublicationAt`.

[`migrations.ts`](migrations.ts) imports and decodes the ordered artifacts with `SqliteMigrations.decodeHistory`. There is no inferred migration planner or migration CLI: future changes require an explicit target snapshot, steps, and value/source copies. Do not edit an artifact already applied to a database; startup verifies the history ledger and exact managed schema before replaying pending artifacts.

The server enables the generated admin surface at [http://127.0.0.1:3000/admin](http://127.0.0.1:3000/admin). It is an administrative view of planning records, not a publication workflow.
