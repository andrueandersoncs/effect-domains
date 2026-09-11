# Change a stored schema

Use this guide when an existing SQLite application needs a deliberate physical schema change without losing rows. Effect Domains provides neither a migration planner nor a schema CLI: author a frozen JSON artifact, append it to the imported history, and replay it on a disposable database.

## Keep the imported history immutable

The editorial-calendar application imports its artifacts and passes them to `SqliteMigrations.history`:

```ts
import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import initial from "./migrations/001_initial.json" with { type: "json" }
import documentMetadata from "./migrations/002_document_metadata.json" with { type: "json" }
import schemaStringChecks from "./migrations/003_schema_string_checks.json" with { type: "json" }
import editorialMetadata from "./migrations/004_editorial_metadata.json" with { type: "json" }

export const EditorialCalendarMigrations = SqliteMigrations.history(
  initial,
  documentMetadata,
  schemaStringChecks,
  editorialMetadata,
)
```

Never edit, reorder, or replace an artifact that can appear in a migration ledger. Add a later artifact and import it with the rest. Startup compares canonical artifact text and position with the ledger, verifies the managed schema, and applies pending artifacts transactionally.

## Author a version-2 artifact

A v2 artifact is `{ id, to, steps }`. There is no `from` snapshot: the preceding artifact in `SqliteMigrations.history(...)` is its source. `to` is the complete target snapshot.

This example renames stored `title` to `heading` and gives existing documents `priority: 0`. It creates JSON only; it does not open a database.

```ts
import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Schema, pipe } from "effect"
import { SqliteMigration, SqliteMigrations } from "effect-domains/sqlite-migrations"
import { Table } from "effect-domains/table"
import initial from "./migrations/001_initial.json" with { type: "json" }

const after = Table.make({
  name: "documents",
  schema: Schema.Struct({
    heading: Schema.String,
    priority: Schema.Int,
  }),
})

const next = SqliteMigrations.make({
  id: "002_metadata",
  to: SqliteMigrations.snapshot([after]),
  steps: [SqliteMigrations.steps.RebuildTable.make({
    table: "documents",
    copies: [
      SqliteMigrations.copies.Source.make({ column: "heading", source: "title" }),
      SqliteMigrations.copies.Value.make({ column: "priority", value: 0 }),
    ],
  })],
})

const json = Schema.toCodecJson(SqliteMigration)
const program = Effect.gen(function* () {
  const artifact = yield* Schema.encodeEffect(json)(next)
  SqliteMigrations.history(initial, artifact)
  yield* Console.log(JSON.stringify(artifact, null, 2))
})
pipe(program, BunRuntime.runMain)
```

Save the emitted object as `migrations/002_metadata.json`, import it, and append it to `SqliteMigrations.history(...)`. The artifact has no embedded table snapshots in its steps: `CreateTable`, `RebuildTable`, and `CreateIndex` name objects declared by its `to` snapshot.

A rebuild's `copies` only names changed, renamed, or backfilled columns. Existing same-named columns are copied by identity automatically. Use `copies.Source` for a rename, `copies.Value` for a scalar value (including `null`), and `copies.Expression` for one SQL expression evaluated against the preceding physical table.

| Step | Change |
| --- | --- |
| `CreateTable.make({ table })` | Create a target table by name. |
| `AddColumn.make({ table, column })` | Add one physical column. |
| `RenameColumn.make({ table, from, to })` | Rename one physical column. |
| `RebuildTable.make({ table, copies? })` | Rebuild the named target table. |
| `CreateIndex.make({ table, name })` / `DropIndex.make({ table, name })` | Change a named declared index. |

Use `SqliteMigrations.initial({ id, tables })` only for a new history. It derives the target snapshot and name-referenced table/index creation steps.

## Replay before applying

Use a disposable database seeded by the previous frozen history and rows that exercise each retained, renamed, defaulted, and expression-derived value. Then start the application with the full imported history.

```bash
SCRATCH_DIR="$(mktemp -d)"
export EDITORIAL_CALENDAR_DB="$SCRATCH_DIR/editorial-calendar.sqlite"
bun run editorial-calendar:seed-v1
PORT=3001 bun run editorial-calendar:server
```

In a second terminal, exercise the changed path:

```bash
export EDITORIAL_CALENDAR_URL=http://127.0.0.1:3001/rpc/v1
bun run editorial-calendar documents.list
bun run editorial-calendar documents.create --input-json '{"heading":"Trail conditions for October","summary":"A practical weekend guide.","priority":2,"channel":"newsletter","plannedPublicationAt":"2026-10-01T09:00:00.000Z"}'
```

The [editorial artifact](../../examples/editorial-calendar/migrations/004_editorial_metadata.json) rebuilds `documents`; its explicit copies provide only `channel` and `plannedPublicationAt`, while unchanged columns are identity copied. Verify representative rows, constraints, and indexes through application paths before committing the artifact with its changed current schema and `migrations.ts` import.

At startup the runtime rejects a history that does not end at the application schema, untracked database history, changed ledger artifacts, or schema drift. It verifies target schema and foreign keys before recording each pending artifact.

## Sources

- [`SqliteMigrations`](../../packages/effect-domains/src/sqlite-migrations.ts)
- [Editorial migration history](../../examples/editorial-calendar/migrations.ts)
- [Editorial artifact](../../examples/editorial-calendar/migrations/004_editorial_metadata.json)
