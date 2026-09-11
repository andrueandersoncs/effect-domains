# Example applications

Each example solves a concrete record-keeping or operational problem. Small does not mean artificial: start with a personal reading list, then compare authored expense queries, scoped team tasks, encrypted field notes, historical editorial planning, equipment tools, a joined repair board, transactional reservations and billing, and durable reports and notifications. Each application owns its domain schema; framework capabilities are the implementation, not the domain.

Every application has a standalone guide with setup, a runnable workflow, expected results and failures, runtime settings, and source links. Choose one below; this page contains only conventions shared across applications and migration-authoring guidance.

## Choose an application

| Application | Useful scenario | Principal boundary |
| --- | --- | --- |
| [reading-list](reading-list/README.md) | Maintain a reading backlog and record progress and ratings | Generated CRUD and filtered lists |
| [expense-ledger](expense-ledger/README.md) | Record expenses and review period/category totals by currency | Authored SQL and checked money |
| [team-tasks](team-tasks/README.md) | Track project work, priorities, and completion | Tenant/owner policy and completion locks |
| [field-notes](field-notes/README.md) | Share site observations with encrypted report text | Role policy independent of storage encryption |
| [editorial-calendar](editorial-calendar/README.md) | Plan articles by channel and publication date | Historical rename and explicit backfill |
| [equipment-register](equipment-register/README.md) | Register, relocate, and inspect equipment through MCP tools | Unique asset tags and generated tool contracts |
| [repair-workshop](repair-workshop/README.md) | Track customer repairs with optional technician assignments | Derived joined projections and declared query dependencies |
| [reservations](reservations/README.md) | Hold stock, confirm it, or release it | Explicit transitions and transactional inventory |
| [orders-invoices](orders-invoices/README.md) | Build an order, issue an invoice, and record payment | Tenant relations, transactions, optimistic versions |
| [purchased-guides](purchased-guides/README.md) | Read a guide unlocked by a one-time purchase | Tenant visibility and current per-resource entitlements |
| [report-exports](report-exports/README.md) | Approve and publish a financial JSON report | Account subscription gating and durable artifact writing |
| [appointment-reminders](appointment-reminders/README.md) | Schedule an appointment notification in an application inbox | Durable scheduling, deduplication, and retention |

## Shared runtime

Run commands from the repository root:

```bash
bun install
bun run build
bun run reading-list:server
```

Use the generated CLI in another terminal: `bun run reading-list --help`. Servers default to `http://127.0.0.1:3000`; CLIs use `http://127.0.0.1:3000/rpc/v1`. Set `PORT` on the server and the matching `<APPLICATION>_URL` on the client when running multiple examples. Environment prefixes are uppercase with underscores: `READING_LIST_DB`, `TEAM_TASKS_TOKEN`, and so on. Databases default to `data/<application>.sqlite`; protected examples also need their separate identity database.

Reading-list OTLP export: `bun run reading-list:server:otel` plus `bun run reading-list:otel …` against a collector on `127.0.0.1:4318`. See [reading-list traces](reading-list/README.md#opentelemetry-traces) and the [runtime reference](../docs/reference/runtime.md#opentelemetry-tracing).

Applications apply ordered, frozen JSON migrations imported in `migrations.ts`. Startup preserves rows and rejects untracked databases rather than silently adopting them. Report exports persist account subscriptions in application storage; native Effect manages its separate durable execution storage. The appointment example likewise has separate application and execution stores. Use a fresh database for a walkthrough that assumes seeded or empty state, not an existing database containing work you need to keep.

### Example identity

Team tasks, field notes, orders/invoices, purchased guides, report exports, and appointment reminders protect their application RPCs with issued sessions. In each protected walkthrough, configure the server with a required bootstrap password and a physically distinct identity database; the account seeds are inserted once, so restarts preserve changed account state:

```bash
export EFFECT_DOMAINS_DEMO_PASSWORD='choose-a-local-bootstrap-password'
export EFFECT_DOMAINS_IDENTITY_DB="$(mktemp -d)/identity.sqlite"
```

Never set `EFFECT_DOMAINS_IDENTITY_DB` to the application database. The seeded accounts are Alice (Acme editor), Bob (Acme reader), Admin (Acme administrator), and Outsider (Alice in tenant `other`); this is example bootstrap data, not a production user-management or IdP system.

After setting the protected application's `<APPLICATION>_URL`, issue a bearer credential for each user needed by its workflow. This recipe uses the native `identity.login` RPC, safely serializes the password with Bun, and extracts the returned secret without adding a `jq` dependency:

```bash
export DEMO_PASSWORD='the-server-bootstrap-password'
export TEAM_TASKS_TOKEN="$(
  bun run team-tasks identity.login --input-json "$(
    bun -e 'const password = process.env.DEMO_PASSWORD; if (!password) throw new Error("DEMO_PASSWORD is required"); console.log(JSON.stringify({ username: "alice", password }))'
  )" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).token)'
)"
```

Treat the token as a secret. The CLI sends `<APPLICATION>_TOKEN` as a bearer credential on every protected call. `identity.current` returns the verified subject and expiry; `identity.logout` revokes the current session:

```bash
bun run team-tasks identity.current
bun run team-tasks identity.logout
unset TEAM_TASKS_TOKEN
```

Sessions expire after `EFFECT_DOMAINS_SESSION_LIFETIME` (eight hours by default). Login accounts bootstrap only once; `EFFECT_DOMAINS_DEMO_PASSWORD` is still required at every startup but does not reset passwords, roles, or disabled state. Browser pages likewise begin signed out and keep a successful token only in memory.

Task ownership comes from verified subject claims, not caller-supplied owner/tenant fields. Field notes form a shared global collection: tenant claims do not partition it. Their encryption key is separate from the bearer token. Policy belongs in resource configuration, not canonical schemas.

Appointment scheduling and inbox reads are admin-only. Report generation requires an editor and a current subscription, while report polling, release, resume, status, and operator metrics require the administrator role. Other applications explicitly allow public access. Missing, expired, revoked, or unknown credentials fail authentication.
### Shared structure

- `domain.ts`: canonical values and domain errors.
- `resources.ts`: storage registration, policies, and selected generated operations.
- `contracts.ts` and `sqlite.ts` where needed: native RPC contracts and authored SQL semantics.
- `application.ts`: `Application.make({ name, parts })` composition.
- `migrations.ts`: ordered artifact imports decoded by `SqliteMigrations.decodeHistory`.
- `main.ts`: shared `serve`, `inspect`, remote CLI, and optional `worker` runner.
- `web/`: Foldkit SPA for the application’s primary workflow, served at `/`.

Services, initialization, native background layers, routes, admin opt-in, and the Foldkit page are explicit. There is no extra command wrapper, migration manifest loader, inferred migration planner, or framework jobs registry.

Task due dates and expense dates share `CalendarDateSchema` from `effect-domains/domain`, preserving Gregorian date-only strings. Expense create/get/update use resource repositories beneath their authored RPCs; range totals and deleted-row removal remain authored SQL. Billing uses native schema JSON codecs for aggregate projections. Example support supplies `privateSqlite(filename)` and `replaceFileAtomically({ path, contents })`; applications still own execution layers, output contents, destinations, and error policy.

## Generated lists

Every generated list returns `{ items, nextCursor }`, defaults to its configured maximum (50 unless overridden), and orders by identifier ascending. Applications declare supported equality filters and page-size bounds; each guide lists its actual settings. Pass a non-null cursor back unchanged with the same filters. Authored expense and workshop queries deliberately have their own ordering and bounded-array contracts, without cursors.

## Foldkit frontends

Every application `serve` command also serves a small [Foldkit](https://foldkit.dev/) page at `/`. It is a hand-authored Elm-architecture UI over the same native `/rpc/v1` operations as the CLI, not a second API. Protected pages start signed out and provide login/logout; tokens remain in browser memory and roles are enforced by the server. Lists with cursor support append through **Load more** controls, while fixed-limit authored projections state their bound in the individual guide. Filter/query and session changes invalidate old results; forms surface field-specific validation errors. Build assets with `bun run build` from the repository root (`apps/admin` plus `packages/example-web`). Missing frontend files fail serve the same way missing admin assets do. Shared shell, RPC helper, and static routes live in [`packages/example-web`](../packages/example-web/).

## Generated admin

Reading lists, expenses, tasks, notes, editorial planning, repair workshops, reservations, and billing enable `/admin`. Build assets first with `bun run build`. Equipment, purchased guides, and the durable applications do not enable admin, but still need the build for their Foldkit pages.

Admin uses the same published RPC schemas, handlers, codecs, and authorization as the CLI. It neither infers permissions nor bypasses policy. For protected applications, paste a real issued bearer credential; the page keeps it in browser memory only. Generated forms support scalar and structured inputs, a full JSON fallback, declared list filters, and cursor navigation. See the [browser source](../apps/admin/src/client.ts) and [native adapter](../packages/effect-domains/src/application-admin.ts).

## CLI conventions

Operation input is canonical JSON supplied through `--input-json`; there are no generated field flags. Use camelCase keys, JSON numbers/booleans, and declared ISO timestamp representations. Storage-only ciphertext never belongs in canonical CLI input. No-payload calls need no input; empty structs and all-optional payloads default to `{}`. `inspect [operation]` is local and needs no server or token.

The endpoint uses Effect JSON RPC, not REST. Use the generated CLI or Effect `RpcClient` instead of duplicating its envelope. Success is JSON on stdout; schema, domain, authorization, and transport failures exit nonzero.

## MCP server

Tool arguments are `{ "input": <RPC JSON payload> }`. Successful structured content is `{ "result": <RPC JSON result> }`, also returned as JSON text; void becomes null. Declared failures return `isError: true` and the encoded domain error. Protected tools require a real issued bearer credential on every call; an MCP transport session is not an identity. Discovery exposes contracts, not protected rows. The [equipment walkthrough](equipment-register/README.md) uses the official SDK.

## Durable execution boundaries

[Report exports](report-exports/README.md) and [appointment reminders](appointment-reminders/README.md) use native SingleRunner: run either serve or worker against an execution store, never both concurrently. Their individual guides cover acceptance, completion, output paths, and restart procedures. Back up both application and execution databases. [Shared isolation](../packages/example-support/src/databases.ts) checks opened paths and inodes before native execution storage initializes.

Application and execution transactions are separate. There is no cross-database transaction, automatic outbox, or exactly-once guarantee for arbitrary external services. Report writes use an execution-ID artifact and atomic rename; inbox inserts deduplicate in the application database. Entity/Cron registrations capture application SQL explicitly because native Sharding supplies private execution SQL in its invocation context. See the [native runtime contract](../docs/wiki/tables-and-queries.md#native-durable-execution).

## Review schema changes

There is no schema CLI or inferred migration planner. Author a frozen artifact with `SqliteMigrations.make({ id, from, to, steps })`; use `initial({ id, tables })` only for fresh table/index creation. `snapshot(tables)` captures the target, and `decodeHistory(raw)` validates an ordered array of imported artifact JSONs as an Effect. Runtime configuration is `database: { migrations, filename? }`, where `migrations` is the decoded history. There is no manifest file or loader.

The following standalone authoring example creates a fresh history, then explicitly renames stored `title` to `heading` and supplies `priority: 0` through a rebuild. Save it as `author-migration.ts` at the repository root. It prints JSON only; it does not touch an application database or runtime history module:

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

Run it and inspect the draft:

```bash
bun run author-migration.ts > migration-history-draft.json
bun run editorial-calendar inspect documents.create
```

The draft array is suitable for `decodeHistory`. Save each artifact as a separate JSON object, import it in the application's `migrations.ts`, and append it to the ordered array passed to `SqliteMigrations.decodeHistory`. For an existing application, use the last frozen artifact's `to` as `from`, not a reconstructed historical schema. Review the new artifact and history module together. Replay the complete history on a disposable database, including representative old rows, before using it for normal startup. Construction and decoding validate structure, snapshots, and expression syntax; only replay checks that authored steps actually produce the target. File writing and history registration are authored tooling, not a framework atomic-write guarantee. Remove the draft files after review; never regenerate already-applied artifacts from current models.

`SqliteMigrations.steps` exposes actual schema constructors; call each with `.make(...)`:

| Step | Authored change |
| --- | --- |
| `CreateTable` | Create a frozen table definition |
| `AddColumn` | Add an explicit physical column |
| `RenameColumn` | Rename one physical column |
| `RebuildTable` | Supply the complete target table and explicit copy mappings |
| `CreateIndex` / `DropIndex` | Create or remove a declared secondary index |

Rebuild mappings use `SqliteMigrations.copies.Source` for original columns, `.Value` for stored scalar constants, or `.Expression` for a single SQL expression. Expressions run in the `SELECT` over the physical **from** table. The frozen [timestamp artifact](reservations/migrations/002_timestamp.json) converts historical epoch seconds to ISO text. Interacting renames can copy original columns in a rebuild rather than rely on sequential renames.

The task, editorial, and reservation histories retain `003_schema_string_checks`, which removes previously misderived SQLite string-length constraints while preserving rows. Canonical string checks remain enforced by schemas. These historical artifacts remain unchanged.

Runtime checks immutable ledger contents and exact table/index definitions, rejects untracked tables, indexes, and triggers, and applies each artifact transactionally. Authors use explicit rebuilds for unique/foreign-key changes and explicit create/drop steps for index changes. The final schema and `foreign_key_check` must pass before the artifact is recorded and committed; invalid rows or inconsistent steps roll back the migration and its ledger entry. No rename/backfill/transform intent language, inferred joins, cascades, or general custom-object migration system is provided. ([Relational contract](../docs/wiki/tables-and-queries.md#relational-storage-declarations))

## Framework code map

- [`ApplicationBun`](../packages/effect-domains/src/application-bun.ts): shared HTTP server and CLI runtime.
- [`Resource`](../packages/effect-domains/src/resource.ts): generated repositories, selected RPC contracts, groups, and handlers.
- [`Authorization`](../packages/effect-domains/src/authorization.ts): typed resource policy declarations and evaluator.
- [`AuthorizationRpc.Authenticator`](../packages/effect-domains/src/authorization-rpc.ts): subject-only authorization boundary; [`IdentityRpcs`](../packages/effect-domains/src/identity-rpc.ts) and [`example identity`](../packages/example-support/src/identity.ts) provide the issued-session example layer.
- [Authored SQL](expense-ledger/sqlite.ts): Effect `SqlSchema` request/result codecs and native `SqlClient` access.
- [`RpcCli`](../packages/effect-domains/src/rpc-cli.ts): native operation subcommands with canonical JSON input.
- [`SqliteMigrations`](../packages/effect-domains/src/sqlite-migrations.ts): frozen snapshots, explicit migration steps, and verified transactional replay.
