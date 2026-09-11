# Change a stored schema

Use this guide when an existing SQLite application needs a deliberate physical schema change without losing its rows. Effect Domains does not provide a schema CLI, a migration planner, or a generated backfill. You author a frozen JSON artifact, import the ordered history in the application, and replay it on a disposable database before normal startup.

## Review an existing history first

The editorial-calendar application is the working example. Its runtime imports individual JSON artifacts and decodes the ordered array:

```ts
import { Effect, pipe } from "effect"
import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import initial from "./migrations/001_initial.json" with { type: "json" }
import documentMetadata from "./migrations/002_document_metadata.json" with { type: "json" }
import schemaStringChecks from "./migrations/003_schema_string_checks.json" with { type: "json" }
import editorialMetadata from "./migrations/004_editorial_metadata.json" with { type: "json" }

const rawHistory = [initial, documentMetadata, schemaStringChecks, editorialMetadata]

export const EditorialCalendarMigrations = pipe(
  rawHistory,
  SqliteMigrations.decodeHistory,
  Effect.runSync,
)
```

[`004_editorial_metadata`](../../examples/editorial-calendar/migrations/004_editorial_metadata.json) rebuilds `documents`, copies `id`, `heading`, `summary`, and `priority`, supplies `channel: "website"`, and leaves the new nullable `plannedPublicationAt` unset. It follows the frozen `003` artifact; it does not reconstruct an earlier schema from today's domain model. Read the [complete editorial history](../../examples/editorial-calendar/migrations.ts) and [historical walkthrough](../../examples/editorial-calendar/README.md) before designing a comparable change.

Never edit, reorder, or replace an artifact that might already appear in a database's migration ledger. Add a new artifact after the last imported one. Runtime compares the exact canonical artifact text and its position with the ledger, verifies the current managed schema, and applies each pending artifact transactionally.

## Author the next artifact explicitly

Start from the last frozen artifact's `to` snapshot. Define the intended current `Table` schema separately, take its snapshot, and choose each physical step and every copy/backfill. Use `initial({ id, tables })` only to create a brand-new history.

This complete script demonstrates a history that renames stored `title` to `heading` and gives existing documents `priority: 0`. Save it as `author-migration.ts` at the repository root. It only writes encoded JSON to stdout; it does not open or change an application database.

```ts
import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Schema, pipe } from "effect"
import { SqliteMigration, SqliteMigrations } from "effect-domains/sqlite-migrations"
import { Table } from "effect-domains/table"

const before = Table.make({
  name: "documents",
  schema: Schema.Struct({ title: Schema.String }),
})
const after = Table.make({
  name: "documents",
  schema: Schema.Struct({ heading: Schema.String, priority: Schema.Int }),
})
const first = SqliteMigrations.initial({ id: "001_initial", tables: [before] })
const target = SqliteMigrations.snapshot([after])
const next = SqliteMigrations.make({
  id: "002_metadata",
  from: first.to,
  to: target,
  steps: [SqliteMigrations.steps.RebuildTable.make({
    table: Table.snapshot(after),
    copies: [
      SqliteMigrations.copies.Source.make({ column: "id", source: "id" }),
      SqliteMigrations.copies.Source.make({ column: "heading", source: "title" }),
      SqliteMigrations.copies.Value.make({ column: "priority", value: 0 }),
    ],
  })],
})
const json = Schema.Array(Schema.toCodecJson(SqliteMigration))
const program = Effect.gen(function* () {
  const encoded = yield* Schema.encodeEffect(json)([first, next])
  yield* SqliteMigrations.decodeHistory(encoded)
  yield* Console.log(JSON.stringify(encoded, null, 2))
})
pipe(program, BunRuntime.runMain)
```

From the repository root, run the script and review the emitted JSON. `decodeHistory` checks that the encoded history is structurally valid and contiguous; it does not apply SQL.

```bash
bun run author-migration.ts > migration-history-draft.json
```

For an existing application, replace `first.to` with the previous frozen artifact's `to`, encode the complete ordered history for review, then save only the new artifact object as a new `migrations/NNN_descriptive_name.json` file. Import that JSON with `with { type: "json" }` and append it to the existing `rawHistory` array. Keep artifacts as JSON imports, not an ad-hoc manifest or loader.

Choose a step that states the storage operation you intend:

- `CreateTable` creates a frozen table definition.
- `AddColumn` adds one explicit physical column.
- `RenameColumn` renames one physical column.
- `RebuildTable` supplies the complete target table and a mapping for every value that must survive or be backfilled.
- `CreateIndex` and `DropIndex` change declared secondary indexes.

A rebuild maps an old value with `copies.Source`, a scalar backfill with `copies.Value`, or one SQL expression evaluated against the physical **from** table with `copies.Expression`. Use a rebuild for changes that need a new table definition, such as the editorial-calendar backfill; do not rely on an inferred rename or transformation. The supported constructors are defined in [`SqliteMigrations`](../../packages/effect-domains/src/sqlite-migrations.ts).

## Replay safely on a scratch database

There is no migration dry-run command. The safe proof is an actual startup against a disposable SQLite file containing representative old rows. The editorial-calendar scenario supplies such a row and its old version-one schema.

After `bun install` and `bun run build` have been run at the repository root, use the first terminal to create a scratch path, seed the frozen version-one database, and start the application with the full checked-in history:

```bash
SCRATCH_DIR="$(mktemp -d)"
export EDITORIAL_CALENDAR_DB="$SCRATCH_DIR/editorial-calendar.sqlite"
bun run editorial-calendar:seed-v1
PORT=3001 bun run editorial-calendar:server
```

Leave the server running. In a second terminal at the repository root, point the CLI at it. This application is public, so it needs no bearer token.

```bash
export EDITORIAL_CALENDAR_URL=http://127.0.0.1:3001/rpc/v1
bun run editorial-calendar documents.list
bun run editorial-calendar documents.create --input-json '{"heading":"Trail conditions for October","summary":"A practical weekend guide.","priority":2,"channel":"newsletter","plannedPublicationAt":"2026-10-01T09:00:00.000Z"}'
```

The list contains the seeded `Autumn trail guide` after replay with the same identifier, `heading: "Autumn trail guide"`, `summary: null`, `priority: 0`, `channel: "website"`, and `plannedPublicationAt: null`. Creation then succeeds with the new fields. This is a real replay of the four imported artifacts, not an inspection-only check.

For your application, make the scratch database from a pre-migration backup or a seed program that uses the previous frozen history, include rows that exercise each copy/default/expression, then start the application with the new ordered imports. Confirm the rows, constraints, and indexes through the application paths that use them. Do not point an unreviewed artifact at a normal database first.

## Apply the reviewed change

After review and scratch replay, commit the new JSON artifact and its `migrations.ts` import together with the changed current schema. Do not mutate applied artifact files to fix a mistake: author a later corrective artifact. At startup the runtime rejects a supplied history that does not end at the application schema, a database with untracked history, changed ledger artifacts, or an unexpected managed schema. Pending steps verify the target schema and foreign keys before their immutable ledger entry is recorded in the transaction. See the [runtime implementation](../../packages/effect-domains/src/sqlite-migrations.ts) and [editorial application](../../examples/editorial-calendar/README.md).
