# Editorial calendar

Plan an article for the website, newsletter, or print edition, then see how the same current application upgrades a deliberately disposable version-one database. This is a public, loopback-only planning tool: it records editorial plans; it does not publish, approve, schedule delivery, or authenticate users.

[All examples](../README.md)

## Run the historical upgrade

Run these commands from the repository root. First install dependencies and build the Foldkit and admin assets; the server loads those prebuilt files rather than compiling them.

```bash
bun install
bun run build
```

Choose a **new, disposable** SQLite path. Do not point this walkthrough at a useful database: `seed-v1` intentionally prepares the old schema, and it does not reset, downgrade, or make a copy of a current database.

```bash
export EDITORIAL_CALENDAR_DB="$(mktemp -d)/editorial-calendar.sqlite"
bun run editorial-calendar:seed-v1
```

The seed command idempotently ensures exactly one version-one document, `Autumn trail guide`, in the old `documents` table, so rerunning it makes no additional row. Now leave that terminal free and start the current server against the same path:

```bash
bun run editorial-calendar:server
```

In a second terminal, set the CLI endpoint and list the upgraded row:

```bash
export EDITORIAL_CALENDAR_URL="http://127.0.0.1:3000/rpc/v1"
bun run editorial-calendar documents.list
```

The result is a page with `items` and `nextCursor`. Its historical item retains its UUIDv7 `id` and has these current values:

```json
{
  "heading": "Autumn trail guide",
  "summary": null,
  "priority": 0,
  "channel": "website",
  "plannedPublicationAt": null
}
```

The generated list orders identifiers ascending. Its `limit` maximum is 50 (and is also the default); a non-null `nextCursor` can be supplied unchanged with the same filters to fetch another page. The Foldkit page appends later pages with **Load more**.

### What the upgrade changed

The demonstrated history is the checked-in ordered import in [`migrations.ts`](migrations.ts), not a migration inferred at startup.

1. [`001_initial`](migrations/001_initial.json) created `documents` with a UUIDv7 `id` and non-empty `title`.
2. [`002_document_metadata`](migrations/002_document_metadata.json) rebuilt that table, copying `id`, copying old `title` into `heading`, adding nullable `summary`, and writing `priority: 0`.
3. [`003_schema_string_checks`](migrations/003_schema_string_checks.json) rebuilt the same rows while removing the physical heading-length check.
4. [`004_editorial_metadata`](migrations/004_editorial_metadata.json) kept `id`, `heading`, `summary`, and `priority`, wrote `channel: "website"`, and omitted the nullable target `plannedPublicationAt`, so it becomes `null`.

The seed is isolated to [`legacy.ts`](legacy.ts) and [`seed-v1.ts`](seed-v1.ts). It uses only the first artifact, so it is for this disposable demonstration—not a way to insert legacy rows into an upgraded store. On a fresh database, the current server instead applies the full history and creates no historical article. On a known history, a restart verifies and reuses it; it does not reset articles. A database with untracked tables, schema drift, or a different/changed recorded migration history is rejected rather than adopted. For migration mechanics and authoring future changes, see the [shared migration walkthrough](../README.md#review-schema-changes) and [`sqlite-migrations.ts`](../../packages/effect-domains/src/sqlite-migrations.ts).

## Plan an article

The current record has an implicit UUIDv7 `id` plus the following fields from [`domain.ts`](domain.ts):

| Field | Create/update value |
| --- | --- |
| `heading` | Required non-empty string |
| `summary` | String or `null` |
| `priority` | Non-negative integer |
| `channel` | `website`, `newsletter`, or `print` |
| `plannedPublicationAt` | ISO UTC timestamp string or `null` |

Create a newsletter plan with every current field:

```bash
bun run editorial-calendar documents.create --input-json '{"heading":"Trail conditions for October","summary":"A practical weekend guide.","priority":2,"channel":"newsletter","plannedPublicationAt":"2026-10-01T09:00:00.000Z"}'
```

The command prints the complete record, including its generated `id`. Copy that value and assign it literally in this terminal—for example, replace `PASTE_RETURNED_ID` below with the `id` just printed:

```bash
export ARTICLE_ID='PASTE_RETURNED_ID'
```

Read it, replace its complete stored value, and remove it:

```bash
bun run editorial-calendar documents.get --input-json "{\"id\":\"$ARTICLE_ID\"}"
bun run editorial-calendar documents.update --input-json "{\"id\":\"$ARTICLE_ID\",\"heading\":\"Trail conditions for October\",\"summary\":\"Updated for the newsletter.\",\"priority\":1,\"channel\":\"newsletter\",\"plannedPublicationAt\":\"2026-10-02T09:00:00.000Z\"}"
bun run editorial-calendar documents.remove --input-json "{\"id\":\"$ARTICLE_ID\"}"
bun run editorial-calendar documents.get --input-json "{\"id\":\"$ARTICLE_ID\"}"
```

`update` is a replacement, so include `id` and every field rather than only the changed summary. `remove` returns no record; the subsequent `documents.get` for that UUID fails with the generated `ResourceNotFound` error. A blank heading, negative/non-integer priority, a channel outside the three literals, or a non-ISO publication value fails input validation and exits nonzero.

Inspect the published contract without a running server:

```bash
bun run editorial-calendar inspect documents.create
```

[`resources.ts`](resources.ts) selects the generated `documents.get`, `documents.list`, `documents.create`, `documents.update`, and `documents.remove` operations. There is no domain-specific publication transition behind them.

## Browser, admin, and MCP

With the server above:

- [http://127.0.0.1:3000/](http://127.0.0.1:3000/) is the Foldkit planning page. Its native client loads and appends up to 50 articles per page; **Load more** follows a returned cursor. Add, edit, and remove one article; blank summary/publication inputs become `null`, and field-specific validation errors are displayed. Saving or removing refreshes the list.
- [http://127.0.0.1:3000/admin](http://127.0.0.1:3000/admin) is the generated admin for the same operations. It needs the earlier `bun run build`.
- `http://127.0.0.1:3000/mcp` is Streamable HTTP MCP. Its generated tools wrap the same canonical payload as `{ "input": <payload> }`; `/rpc/v1` is Effect JSON RPC, not REST.

All three surfaces are public for this example and bind only to `127.0.0.1`; no token, login, or production deployment configuration is supplied. For common endpoint, CLI, and MCP behavior, see the [runtime reference](../../docs/reference/runtime.md).

## Settings and source map

| Setting | Default | Use |
| --- | --- | --- |
| `EDITORIAL_CALENDAR_DB` | `data/editorial-calendar.sqlite` | SQLite path used by both the legacy seed and current server |
| `PORT` | `3000` | Loopback server port |
| `EDITORIAL_CALENDAR_URL` | `http://127.0.0.1:3000/rpc/v1` | Remote CLI endpoint |

To run beside another example, use matching settings in separate terminals:

```bash
PORT=3001 EDITORIAL_CALENDAR_DB="$PWD/editorial-calendar-local.sqlite" bun run editorial-calendar:server
EDITORIAL_CALENDAR_URL="http://127.0.0.1:3001/rpc/v1" bun run editorial-calendar documents.list
```

- [`domain.ts`](domain.ts) defines current planning values.
- [`resources.ts`](resources.ts) publishes the CRUD surface.
- [`seed-v1.ts`](seed-v1.ts), [`legacy.ts`](legacy.ts), and [`migrations/`](migrations/) contain the historical demonstration and immutable artifacts.
- [`main.ts`](main.ts) enables the server, generated admin, and Foldkit routes.
- [`web/main.ts`](web/main.ts) is the application-specific browser workflow.
