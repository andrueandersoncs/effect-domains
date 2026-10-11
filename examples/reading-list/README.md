# Reading list: contract-derived book editor

[All examples](../README.md)

Add two books, move one from reading to finished, page through the backlog, and remove an entry. This is the smallest example to run before comparing [authored expense queries](../expense-ledger/README.md) or [tenant-scoped tasks](../team-tasks/README.md).

This small public reading list uses one local canonical schema and generated CRUD. A book has a title, author, reading status, format, optional rating, and optional notes; title, author, and notes (when supplied) cannot be empty, and ratings are whole numbers from 1 through 5.

```ts
export const ReadingListResource = Resource.define({
  authorization: Authorization.public,
  name: "books",
  schema: ReadingListBookSchema,
  capabilities: [
    Resource.get(),
    Resource.list({ filter: ["status", "format"], limit: 25 }),
    Resource.create(),
    Resource.update(),
    Resource.remove(),
  ],
})
```

The specification is author intent only. `Resource.compile` derives the five `books.*` RPCs, table, UUIDv7 identifier, schemas, repository, and handlers; the application compiler contributes those products to one `ApplicationIR`.

The generated Application UI consumes that `ApplicationIR` directly. Inspection supplies the five operations, nullable input shapes, `status` and `format` filters, and cursor-page contract. The example supplies only display title and description in `infrastructure.ts`; it has no resource-specific browser state machine or form codec.

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

At `/`, select the Books resource to list rows with declared status/format filters and cursor navigation. Select an operation to run generated create, get, update, or remove forms; complete JSON input remains available for the full canonical payload.

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

## Story-driven browser acceptance

The application-owned [catalog](acceptance/catalog.ts) declares approved reader stories, shared requirement IDs, one declared input case per scenario with typed field sources (fixture facts, approved text, native strategies), native operation/resource references, and a named semantic text fixture. The [fixture](acceptance/fixture.ts) and [evaluators](acceptance/evaluation.ts) are application-owned; the shared runner, browser surface, Jev adapter, native input resolution, evidence, and CLI come from [`@effect-domains/acceptance`](../../packages/effect-domains-acceptance). This implements [Slice A](../../docs/wiki/story-driven-acceptance.md#slice-a-reading-list), not the full SDA-01–SDA-12 framework.

Install Chromium once with `bunx playwright install chromium` from `packages/effect-domains-acceptance`. Then run from the repository root, with `TYPESAFE_API_KEY` in the environment or the untracked root `.env`:

```bash
bun run build
bun run reading-list:acceptance --output data/acceptance/reading-list-review
bun run reading-list:acceptance --replay data/acceptance/reading-list-review/run.json
bun run reading-list:acceptance --help
```

Use a fresh output directory: existing `run.json` is never overwritten. The runner starts the actual Reading List application on fresh loopback ports with owned temporary SQLite databases, seeds an unrelated sentinel and an update target where needed, and opens a fresh Chromium context for each scenario. It does not use your existing application database or require a separately running server. Feature actions use individual generated controls, including enum selects, optional-field inclusion, and nullable JSON-value textareas; they do not use the complete-payload JSON fallback or direct API mutation.

Nine scenarios cover creation with a native sample, explicit null, and omitted rating, update ratings at both native boundaries, nullable update, and rejection below/above the range and at a fractional value. Creation takes title/author from the documented book fixture and native samples for status, format, and notes; updates take every other field from the prepared planned target's fixture facts. Update targets remain planned: finished status is not a rating policy. Native creation metadata supplies omitted-field defaults. The runner does not claim that arbitrary strings prove a useful reader outcome.

Jev `jev-1.13.0` selects currently available semantic actions, with `cannot-proceed` always available. Exact field entries are one bounded payload action over the actual controls, not independent model guesses about equivalent field order. Defaults are confidence **0.55**, **30** actions, a **180-second** scenario deadline, a **30-second** model-call timeout, and seed **42**, kept after the [held-out calibration](../../docs/wiki/validation-strategy.md#2026-10-10-held-out-decision-calibration-ap-09) (reviewed corpus in [`acceptance/calibration.json`](acceptance/calibration.json)). Low confidence stops without executing the selected action or falling back to the first option. Model failure, missing evidence, and incomplete criteria cannot become a pass.

Each output directory contains `run.json`, `verifier.json`, and per-scenario JSON, before/step screenshots, and server logs, plus an ownership marker and sealed `lineage.json`. Results identify the requirement/scenario/evaluator revisions, assertion basis, evidence references, exact candidates, native validation, application/source/bundle hashes, and actual model requests, responses, probability distributions, and executed/unexecuted actions. API keys are not retained, and the run fails if any secret appears in retained bytes. Inspect, export, and prune evidence with `bun run acceptance:evidence` under the `reading-list-evidence@1` policy, and query coverage with `bun run acceptance:query`; see the [acceptance guide](../../docs/guides/acceptance.md).

Replay reuses the captured concrete native values and action trace without Jev, re-resolving fixture facts (the fresh target identity and fields) and approved text. It rejects stale application/catalog/evaluator/binding hashes, missing coverage, altered payload actions, and unavailable targets; an originally unexecuted action stays unexecuted. Reading List has no authored custom surface, so `--repair-locators` has nothing to repair.

Acceptance is determined independently by creation/value/identity, reload, rating, all-row rejection preservation, and sentinel evaluators. Deliberately constructed defective observation controls exercise the same evaluators, and `bun run reading-list:acceptance --faults` injects live defects through an acceptance-owned proxy (success without write, lost after reload, wrong target, rejected-but-mutating, unrelated mutation) plus deadline, action-limit, racing-target, and disabled-submit controls. The approved `rating-rejection-clarity` rubric is assessed by the model against the rejection feedback; its pass or fail is reported as a non-gating model assessment, never as an executable assertion.

Exit **0** means every declared scenario/requirement and verifier control matched its expected outcome. Exit **1** means blocked/inconclusive/failing execution, a prerequisite/evidence failure, a stale replay, or an evidence leak. Inspect the individual results rather than treating action completion as acceptance. The authored catalog is decoded at runtime; a declaration that is `proposed` or lacks an approval for its current revision is reported as not contract-ready. The [completion ledger](../../docs/wiki/story-driven-acceptance.md#closing-gate-review-ap-17-2026-10-11) records which design gates remain open.

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
