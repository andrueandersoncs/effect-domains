# Example applications

Each example solves a concrete record-keeping or operational problem. Small does not mean artificial: start with a personal reading list, then compare authored expense queries, scoped team tasks, encrypted field notes, historical editorial planning, equipment tools, transactional reservations and billing, and durable reports and notifications. Each application owns its domain schema; framework capabilities are the implementation, not the domain.

## Choose an application

| Application | Useful scenario | Principal boundary |
| --- | --- | --- |
| [reading-list](reading-list/README.md) | Maintain a reading backlog and record progress and ratings | Generated CRUD and filtered lists |
| [expense-ledger](#expense-ledger) | Record expenses and review period/category totals by currency | Authored SQL and checked money |
| [team-tasks](team-tasks/README.md) | Track project work, priorities, and completion | Tenant/owner policy and completion locks |
| [field-notes](field-notes/README.md) | Share site observations with encrypted report text | Role policy independent of storage encryption |
| [editorial-calendar](editorial-calendar/README.md) | Plan articles by channel and publication date | Historical rename and explicit backfill |
| [equipment-register](#equipment-register) | Register, relocate, and inspect equipment through MCP tools | Unique asset tags and generated tool contracts |
| [reservations](reservations/README.md) | Hold stock, confirm it, or release it | Explicit transitions and transactional inventory |
| [orders-invoices](#orders-and-invoices) | Build an order, issue an invoice, and record payment | Tenant relations, transactions, optimistic versions |
| [report-exports](#report-exports) | Approve and publish a financial JSON report | Durable approval and queue-backed artifact writing |
| [appointment-reminders](#appointment-reminders) | Schedule an appointment notification in an application inbox | Durable scheduling, deduplication, and retention |

## Shared runtime

Run commands from the repository root:

```bash
bun install
bun run build
bun run reading-list:server
```

Use the generated CLI in another terminal: `bun run reading-list --help`. Servers default to `http://127.0.0.1:3000`; CLIs use `http://127.0.0.1:3000/rpc/v1`. Set `PORT` on the server and the matching `<APPLICATION>_URL` on the client when running multiple examples. Environment prefixes are uppercase with underscores: `READING_LIST_DB`, `TEAM_TASKS_TOKEN`, and so on. Databases default to `<application>.sqlite` in the working directory.

Table-bearing applications apply ordered, frozen JSON migrations imported in `migrations.ts`. Startup preserves rows and rejects untracked databases rather than silently adopting them. Report exports have no application tables and use empty history. Native Effect manages separate durable execution storage. New replacement domains use their own databases; these are not automatic conversions from retired book/prefix-codec demos.

### Demo authentication

[Shared authentication](../packages/example-support/src/authentication.ts) resolves exact bearer tokens to server-owned claims. Set tokens on clients:

| Token | User | Tenant | Roles |
| --- | --- | --- | --- |
| `alice-demo` | alice | acme | editor |
| `bob-demo` | bob | acme | reader |
| `admin-demo` | admin | acme | admin |
| `outsider-demo` | alice | other | editor |

Team tasks, field notes, and orders/invoices use these sessions; appointment reminders require the admin session. Report exports require their separately configured operator token. Other applications explicitly allow public access. Missing or unknown credentials fail authentication. These are public demonstration identities, with no login, expiry, revocation, or identity provider. Keep every example on loopback; do not use it as a production deployment template.

Task ownership comes from verified subject claims, not caller-supplied owner/tenant fields. Field notes form a shared global collection: tenant claims do not partition it. Their encryption key is separate from the bearer token. Policy belongs in resource configuration, not canonical schemas.

Appointment scheduling and inbox reads reuse one [subject-only admin policy](appointment-reminders/operator-authorization.ts). Native proxy RPCs install `AuthorizationRpc` and annotate the published group with `AuthorizationRpc.policy`; the middleware checks verified claims before invoking handlers. Billing's authored handlers use `Authorization.requireSubject` for typed read/editor policies. Neither declaration makes persisted execution an authenticated request.

### Shared structure

- `domain.ts`: canonical values and domain errors.
- `resources.ts`: storage registration, policies, and selected generated operations.
- `contracts.ts` and `sqlite.ts` where needed: native RPC contracts and authored SQL semantics.
- `application.ts`: `Application.make({ name, parts })` composition.
- `migrations.ts`: ordered artifact imports decoded by `SqliteMigrations.decodeHistory`.
- `main.ts`: shared `serve`, `inspect`, remote CLI, and optional `worker` runner.

Services, initialization, native background layers, routes, and admin opt-in are explicit. There is no extra command wrapper, migration manifest loader, inferred migration planner, or framework jobs registry.

Task due dates and expense dates share `CalendarDateSchema` from `effect-domains/domain`, preserving Gregorian date-only strings. Expense create/get/update use resource repositories beneath their authored RPCs; range totals and deleted-row removal remain authored SQL. Billing uses native schema JSON codecs for aggregate projections. Example support supplies `privateSqlite(filename)` and `replaceFileAtomically({ path, contents })`; applications still own execution layers, output contents, destinations, and error policy.

## Generated lists

Every generated list returns `{ items, nextCursor }`, defaults to a bounded page, and orders by identifier ascending. Applications declare supported equality filters and limits. Pass a non-null cursor back unchanged with the same filters. Authored expense queries deliberately declare their own ordering and range contract.

## Generated admin

Reading lists, expenses, tasks, notes, editorial planning, reservations, and billing enable `/admin`. Build assets first with `bun run build`. Equipment and the durable applications do not enable admin.

Admin uses the same published RPC schemas, handlers, codecs, and authorization as the CLI. It neither infers permissions nor bypasses policy. Enter a demo bearer token when needed; the page keeps it in browser memory only. Generated forms support scalar and structured inputs, a full JSON fallback, declared list filters, and cursor navigation. See the [browser source](../apps/admin/src/client.ts) and [native adapter](../packages/effect-domains/src/application-admin.ts).

## CLI conventions

Operation input is canonical JSON supplied through `--input-json`; there are no generated field flags. Use camelCase keys, JSON numbers/booleans, and declared ISO timestamp representations. Storage-only ciphertext never belongs in canonical CLI input. No-payload calls need no input; empty structs and all-optional payloads default to `{}`. `inspect [operation]` is local and needs no server or token.

The endpoint uses Effect JSON RPC, not REST. Use the generated CLI or Effect `RpcClient` instead of duplicating its envelope. Success is JSON on stdout; schema, domain, authorization, and transport failures exit nonzero.

## MCP server

Every `serve` command also exposes Streamable HTTP MCP at `http://127.0.0.1:3000/mcp`. Configure an MCP client with that URL; `/rpc/v1` remains the separate CLI endpoint. One generated tool corresponds to each published RPC operation.

Tool arguments are `{ "input": <RPC JSON payload> }`. Successful structured content is `{ "result": <RPC JSON result> }`, also returned as JSON text; void becomes null. Declared failures return `isError: true` and the encoded domain error. Protected tools require the same bearer credentials as RPC on every call; a session is not an identity. Discovery exposes contracts, not protected rows. The [equipment walkthrough](#equipment-register) uses the official SDK.

## Reservation application

The [reservation guide](reservations/README.md) walks through stock reads, reserve, confirm, release, transition failures, and persistence. The [authored commands](reservations/sqlite.ts) own transactional stock accounting; generated operations are read-only. This existing business-policy slice is retained unchanged.

## Expense ledger

[Expense contracts](expense-ledger/contracts.ts) and [authored SQL](expense-ledger/sqlite.ts) record dated merchant expenses, query a bounded period, and calculate category totals separately for each currency. Amounts are positive safe-integer minor units. Calendar dates use YYYY-MM-DD; currencies are uppercase three-letter codes, with no exchange-rate conversion.

```bash
bun run expense-ledger:server
```

In another terminal:

```bash
bun run expense-ledger expenses.record --input-json '{"date":"2026-09-01","merchant":"Railway Cafe","category":"meals","amountMinor":1875,"currency":"USD"}'
bun run expense-ledger expenses.record --input-json '{"date":"2026-09-02","merchant":"Station Bistro","category":"meals","amountMinor":1600,"currency":"EUR"}'
bun run expense-ledger expenses.query --input-json '{"from":"2026-09-01","through":"2026-09-30","category":"meals","limit":10}'
bun run expense-ledger expenses.totals --input-json '{"from":"2026-09-01","through":"2026-09-30"}'
```

Totals return separate EUR and USD rows, not a meaningless combined amount. Queries include both date endpoints, order by date then identifier, and return at most 50 rows by default (maximum 100). This bounded query has no cursor; totals include all matching expenses, independently of the query limit. Categories are meals, travel, software, supplies, and other.

Copy a returned identifier into `EXPENSE_ID`:

```bash
bun run expense-ledger expenses.get --input-json "{\"id\":\"$EXPENSE_ID\"}"
bun run expense-ledger expenses.update --input-json "{\"id\":\"$EXPENSE_ID\",\"date\":\"2026-09-01\",\"merchant\":\"Railway Cafe\",\"category\":\"meals\",\"amountMinor\":1975,\"currency\":\"USD\"}"
bun run expense-ledger expenses.remove --input-json "{\"id\":\"$EXPENSE_ID\"}"
```

Remove returns the deleted expense; subsequent reads report `ExpenseNotFound`. A reversed range reports `InvalidExpenseDateRange`; SQL/codec failures, including unrepresentable totals, report `ExpenseLedgerUnavailable`. Negative amounts and impossible dates fail input validation. `EXPENSE_LEDGER_DB` defaults to `expense-ledger.sqlite`. This is a local expense register, not double-entry accounting, reimbursement approval, or tax software.

## Equipment register

[Equipment records](equipment-register/domain.ts) contain a unique asset tag, name, model, nullable serial number, location, and condition (in-service, needs-repair, or retired). Tags match `EQ-[A-Z0-9]{4,12}`; duplicates fail persistence. A generated UUID identifies each record independently of its editable asset tag.

```bash
bun run equipment-register:server
```

In another terminal, run the [official MCP SDK walkthrough](equipment-register/client.ts):

```bash
bun run equipment-register:client
```

The client discovers generated tools, registers a field camera, reads it, moves it to the editorial desk, finds it by location/condition, marks it retired, removes only its own record, and confirms `ResourceNotFound` afterward. An interrupted run can leave its equipment record behind. It is an inventory register, not a checkout, maintenance-ticket, or depreciation workflow.

The equivalent CLI creation is:

```bash
bun run equipment-register assets.create --input-json '{"assetTag":"EQ-CAM2048","name":"Field camera","model":"X100V","serial":"FJ2-2025-0042","location":"Studio A","condition":"in-service"}'
bun run equipment-register assets.list --input-json '{"filter":{"location":"Studio A","condition":"in-service"}}'
bun run equipment-register inspect assets.create
```

For MCP, call `assets.create` with `{ input: <that JSON object> }`; results are under `structuredContent.result`. `EQUIPMENT_REGISTER_DB` defaults to `equipment-register.sqlite`; `EQUIPMENT_REGISTER_MCP_URL` configures the SDK client (default `http://127.0.0.1:3000/mcp`), and `EQUIPMENT_REGISTER_URL` configures the separate RPC CLI endpoint. No token or admin build is needed for this public loopback application.

## Orders and invoices

[`orders-invoices`](orders-invoices/) exercises a second business-policy domain across orders, order lines, and invoices. [Resource configuration](orders-invoices/resources.ts) declares tenant-local unique numbers, composite tenant/order foreign keys, one invoice per order, and tenant/status indexes. Canonical [schemas](orders-invoices/domain.ts) remain free of storage and authorization declarations. Generated `get`/`list` operations are read-only and tenant-scoped; [authored commands](orders-invoices/sqlite.ts) own every mutation, transaction, role check, and expected-version guard.

Start the server:

```bash
bun run orders-invoices:server
```

In another terminal:

```bash
export ORDERS_INVOICES_TOKEN=alice-demo
bun run orders-invoices billing.createOrder --input-json '{"number":"SO-1","customer":"Example customer"}'
```

Copy its returned `id` into `ORDER_ID`. A new order is draft at version 1:

```bash
bun run orders-invoices billing.addLine --input-json "{\"orderId\":\"$ORDER_ID\",\"expectedVersion\":1,\"lineNumber\":1,\"description\":\"Consulting\",\"quantity\":2,\"unitAmountMinor\":1250}"
bun run orders-invoices billing.issueInvoice --input-json "{\"orderId\":\"$ORDER_ID\",\"expectedVersion\":2,\"number\":\"INV-1\"}"
```

The line advances the order to version 2 and total 2500. Issuing the invoice atomically marks the order invoiced at version 3 and creates an issued invoice at version 1. Copy the invoice's returned `id` into `INVOICE_ID`:

```bash
bun run orders-invoices billing.payInvoice --input-json "{\"invoiceId\":\"$INVOICE_ID\",\"expectedVersion\":1}"
bun run orders-invoices billing.getOrder --input-json "{\"orderId\":\"$ORDER_ID\"}"
ORDERS_INVOICES_TOKEN=bob-demo bun run orders-invoices orders.get --input-json "{\"id\":\"$ORDER_ID\"}"
bun run orders-invoices inspect
```

The paid invoice has version 2. Repeating a mutation with its old version returns `VersionConflict`; re-paying the current paid version returns `InvalidInvoiceTransition`. Readers can query but cannot mutate. Another tenant can reuse `SO-1` or `INV-1` but cannot access or attach a line to this order. Foreign keys also enforce the tenant boundary for privileged SQL.

Amounts are checked safe-integer minor units. Empty orders cannot be invoiced; duplicate numbers, duplicate line numbers, arithmetic overflow, invalid transitions, and stale writes have declared errors. Payment records a local transition, not a payment-provider call. Taxes, currencies, credit notes, production identity, and request-idempotent retries are not implemented; fetch the current summary and make an explicit decision after a conflict.

`ORDERS_INVOICES_DB` defaults to `orders-invoices.sqlite`; `ORDERS_INVOICES_URL` defaults to `http://127.0.0.1:3000/rpc/v1`. Set `PORT` on the server and the matching client URL to run beside another example. Startup applies its frozen [initial history](orders-invoices/migrations.ts), never resets data, and enables foreign keys. The generated admin is available at `/admin` after the shared build; enter a demo bearer token to use it. [Verification](../docs/wiki/validation-strategy.md#2026-09-09-tenant-scoped-orders-and-invoices) records live CLI/browser behavior and rollback/migration regressions.

## Report exports

[Report exports](report-exports/workflow.ts) publish a concrete financial JSON artifact from explicitly supplied account lines and a reporting period. Inputs identify a report, currency (AUD, CAD, EUR, GBP, JPY, or USD), debit/credit amounts, and release policy. This does not query an imaginary accounting system or claim balanced books; the supplied lines are the source data.

Start the server with a private local operator token and output directory:

```bash
export REPORT_EXPORTS_TOKEN=local-operator-secret
export REPORT_EXPORTS_OUTPUT_DIR="$PWD/report-artifacts"
PORT=3001 bun run report-exports:server
```

In another terminal:

```bash
export REPORT_EXPORTS_TOKEN=local-operator-secret
export REPORT_EXPORTS_URL=http://127.0.0.1:3001/rpc/v1
bun run report-exports ReportExport.GenerateDiscard --input-json '{"report":{"reportId":"september-ledger-1","reportingPeriod":{"startsAt":"2026-09-01T00:00:00.000Z","endsAt":"2026-10-01T00:00:00.000Z"},"currency":"USD","releasePolicy":"operatorApproval"},"lines":[{"accountCode":"4000","description":"September consulting revenue","direction":"credit","amountMinor":125000},{"accountCode":"6100","description":"September office supplies","direction":"debit","amountMinor":8500}]}'
```

Copy the returned execution ID into `EXECUTION_ID`:

```bash
bun run report-exports ReportExport.Poll --input-json "{\"executionId\":\"$EXECUTION_ID\"}"
bun run report-exports ReportExport.Release --input-json "{\"executionId\":\"$EXECUTION_ID\"}"
bun run report-exports ReportExport.Poll --input-json "{\"executionId\":\"$EXECUTION_ID\"}"
bun run report-exports ReportExport.Status
```

A native durable clock waits five seconds; operatorApproval reports then wait for explicit release. The automatic policy skips that approval barrier. An Activity prepares JSON and a durable queue worker atomically publishes the artifact. Poll until `Succeeded`, then open the returned `artifactPath`; it contains the report, lines, and currency-local debit/credit totals. `PendingOrUnknown` does not distinguish suspended work from an unknown ID. `Generate` waits for completion, `GenerateDiscard` acknowledges the stable execution ID, and `GenerateResume` explicitly resumes an execution.

Reuse a report ID only to address the same execution; use a fresh ID for different source data. Do not treat repeat submission as replacement. Invalid period ordering, line amounts, and currency syntax fail input validation; unsafe total arithmetic fails the workflow. Release, submission, resume, polling, and status require the configured token; `/operator/metrics` independently requires it too.

Application storage defaults to `report-exports.sqlite` (`REPORT_EXPORTS_DB`); native execution storage defaults to `report-exports-execution.sqlite` (`REPORT_EXPORTS_EXECUTION_DB`). Stop the server and run `bun run report-exports:worker` with the same token, databases, and output directory to continue accepted work without HTTP. Switch back to serve for remote release or polling.

## Appointment reminders

[Appointment reminders](appointment-reminders/appointment-reminder-entity.ts) schedule an actual in-application inbox notification: recipient, appointment ID, appointment time, reminder time, location, and purpose. Delivery means a durable `appointment_notifications` row, not email or SMS. The example does not book appointments or synchronize cancellations with a calendar provider.

```bash
PORT=3002 bun run appointment-reminders:server
```

In another terminal:

```bash
export APPOINTMENT_REMINDERS_URL=http://127.0.0.1:3002/rpc/v1
export APPOINTMENT_REMINDERS_TOKEN=admin-demo
REMINDER_ID=$(bun -e 'console.log(Bun.randomUUIDv7())')
APPOINTMENT_ID=$(bun -e 'console.log(Bun.randomUUIDv7())')
REMINDER_AT=$(bun -e 'console.log(new Date(Date.now() + 30000).toISOString())')
APPOINTMENT_AT=$(bun -e 'console.log(new Date(Date.now() + 3600000).toISOString())')
bun run appointment-reminders AppointmentRecipient.ScheduleReminderDiscard --input-json "{\"entityId\":\"alice\",\"payload\":{\"recipient\":\"alice\",\"reminderId\":\"$REMINDER_ID\",\"appointmentId\":\"$APPOINTMENT_ID\",\"appointmentAt\":\"$APPOINTMENT_AT\",\"reminderAt\":\"$REMINDER_AT\",\"location\":\"Studio A\",\"purpose\":\"Equipment handover\"}}"
bun run appointment-reminders appointment_notifications.list --input-json '{"filter":{"recipient":"alice"}}'
```

Query again after the reminder time to see the inbox row. `ScheduleReminderDiscard` acknowledges acceptance; `ScheduleReminder` takes the same envelope and waits for delivery. Repeat the same recipient, reminder ID, and payload to obtain the same delivery rather than duplicate it. An entity ID differing from the payload recipient fails with `AppointmentRecipientMismatch`. A reminder at or after its appointment fails with `ReminderMustPrecedeAppointment`. Editors cannot schedule or read the admin-only inbox.

Application storage defaults to `appointment-reminders.sqlite` (`APPOINTMENT_REMINDERS_DB`), private execution storage to `appointment-reminders.execution.sqlite` (`APPOINTMENT_REMINDERS_EXECUTION_DB`), and the projection to `appointment-reminders.notifications.json` (`APPOINTMENT_REMINDERS_PROJECTION_FILE`). A Singleton refreshes the projection every five seconds. Cron archives delivered notifications older than 90 days at midnight UTC; `APPOINTMENT_REMINDERS_RETENTION_CRON` explicitly overrides its schedule.

For recovery, accept a future notification, stop the server, then start `bun run appointment-reminders:worker` against the same databases and projection path. Accepted notifications and background projection/retention continue without an HTTP listener. Return to serve to query the inbox remotely.

### Durable execution boundaries

Both applications use native SingleRunner: run either serve or worker against an execution store, never both concurrently. Back up both application and execution databases. [Shared isolation](../packages/example-support/src/databases.ts) checks opened paths and inodes before native execution storage initializes.

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
- [`AuthorizationRpc.Authenticator`](../packages/effect-domains/src/authorization-rpc.ts): request-local verified identity boundary; [demo implementation](../packages/example-support/src/authentication.ts).
- [Authored SQL](expense-ledger/sqlite.ts): Effect `SqlSchema` request/result codecs and native `SqlClient` access.
- [`RpcCli`](../packages/effect-domains/src/rpc-cli.ts): native operation subcommands with canonical JSON input.
- [`SqliteMigrations`](../packages/effect-domains/src/sqlite-migrations.ts): frozen snapshots, explicit migration steps, and verified transactional replay.
