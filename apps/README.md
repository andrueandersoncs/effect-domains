# Applications

Each application is a runnable Bun workspace package. The private repository root separates the `effect-domains` framework library in [`packages/effect-domains`](../packages/effect-domains/), shared fixtures in [`packages/example-support`](../packages/example-support/), the prebuilt browser admin in [`apps/admin`](admin/), and these ten loopback applications. Each has persistent SQLite storage, an HTTP RPC server, a generated CLI, and local schema commands. Table-bearing applications use frozen migration manifests; the durable examples additionally isolate native execution storage from application data.

## Choose an application

| Application | Purpose | Database setting |
| --- | --- | --- |
| [basic-crud](basic-crud/README.md) | Minimal book CRUD generated from one resource declaration | `BASIC_CRUD_DB` |
| [authored-sql](#authored-sql) | Custom book contracts and authored SQL with Effect `SqlSchema` | `AUTHORED_SQL_DB` |
| [resource-crud](resource-crud/README.md) | Tenant/owner todo policies, completion locks, pagination, and patch | `RESOURCE_CRUD_DB` |
| [service-codec](service-codec/README.md) | Reader/editor/admin note permissions alongside a service-dependent storage codec | `SERVICE_CODEC_DB` |
| [migration-lifecycle](migration-lifecycle/README.md) | Document CRUD with historical rename and backfill | `MIGRATION_LIFECYCLE_DB` |
| [reservations](reservations/README.md) | Explicit stock policy and transactional reservation commands | `RESERVATIONS_DB` |
| [orders-invoices](#orders-and-invoices) | Tenant-scoped relational billing, authenticated transactions, and optimistic versions | `ORDERS_INVOICES_DB` |
| [durable-workflows](#durable-workflows) | Approval/export workflow with durable timing and queue-backed file creation | `DURABLE_WORKFLOWS_DB`, `DURABLE_WORKFLOWS_EXECUTION_DB` |
| [durable-reminders](#durable-reminders) | Persisted per-recipient scheduling, receipt projection, and cron retention | `DURABLE_REMINDERS_DB`, `DURABLE_REMINDERS_EXECUTION_DB` |
| [mcp-server](#mcp-client-walkthrough) | Generated book tools consumed by an official MCP SDK client | `MCP_SERVER_DB` |

The guides explain what is generated, what is deliberately authored, how to run each application, and its limitations. Start with [basic-crud](basic-crud/README.md); compare [tenant/owner todo rules](resource-crud/resources.ts) with [role-based note rules](service-codec/resources.ts) to see custom authorization. [Authored SQL](#authored-sql) demonstrates the privileged escape hatch.

## Shared runtime

Install dependencies and prebuild the admin once from the repository root:

```bash
bun install
bun run build
```

Run commands from the repository root. Start one server, then use its CLI in another terminal:

```bash
bun run resource-crud:server
bun run resource-crud --help
```

Each database defaults to `<application>.sqlite` in the working directory. Startup requires and applies frozen migration history, including for a fresh database; it does not reset existing data. An untracked database is rejected rather than silently adopted.

All servers default to `http://127.0.0.1:3000`, and all CLIs default to `http://127.0.0.1:3000/rpc/v1`. To run applications concurrently, assign distinct ports and matching client URLs:

```bash
PORT=3001 BASIC_CRUD_DB=books.sqlite bun run basic-crud:server
BASIC_CRUD_URL=http://127.0.0.1:3001/rpc/v1 bun run basic-crud books.list
```

Client settings follow the database naming convention: `<APPLICATION_NAME>_URL` and `<APPLICATION_NAME>_TOKEN`, with hyphens replaced by underscores and names uppercased. Todo and note RPCs require the demo credentials below; the other five original examples remain explicitly public. The seven resource-focused examples opt into admin at `/admin`; the two durable examples do not. Durable reminders require the admin demo session, while durable workflows require an explicitly configured operator token. These are loopback examples, not production deployment templates.

### Demo authentication

[`ExampleAuthentication`](../packages/example-support/src/authentication.ts) supplies an `AuthorizationRpc.Authenticator` layer to the todo, note, orders/invoices, and durable-reminder applications. It resolves an exact bearer token to server-owned subject claims; missing or unknown tokens fail with `Unauthenticated`. It does not accept user, tenant, or role claims from caller headers.

| Token | User | Tenant | Roles |
| --- | --- | --- | --- |
| `alice-demo` | `alice` | `acme` | `editor` |
| `bob-demo` | `bob` | `acme` | `reader` |
| `admin-demo` | `admin` | `acme` | `admin` |
| `outsider-demo` | `alice` | `other` | `editor` |

These are deliberately public credentials. Anyone who knows a token can impersonate that demo identity; there is no login, expiry, revocation, or production identity provider. Keep these servers on loopback and replace the authenticator for a real application.

Set the token on the **client**, not the server:

```bash
RESOURCE_CRUD_TOKEN=alice-demo bun run resource-crud todos.create \
  --title "Ship authorization examples"
SERVICE_CODEC_TOKEN=alice-demo bun run service-codec notes.create --id example-note --text "Shared notes"
```

Todo creation binds `tenantId` and `ownerId` from the authenticated subject. They are deliberately absent from the generated create input; sending either field is rejected by the server. Full-row updates still include both ownership fields, while the todo guide retains forbidden ownership-patch examples.

Todo policies combine tenant scope, ownership, current completion state, immutable ownership, and admin-only removal. `outsider-demo` deliberately has Alice's user ID in another tenant, demonstrating that ownership alone does not grant access. Existing todos migrate to tenant `acme`, owner `alice`; this is explicit demo backfill intent, not an inferred ownership rule.

Notes instead form one global shared collection: readers can read, editors can create/update, and admins can also remove. Tenant claims do not partition this collection. The storage codec remains independent of authorization. Follow each guide for successful and denied operations.

Policy is declared in `resources.ts`, not in canonical schemas or per-operation handlers. `create.fromSubject` records typed subject provenance for server-injected create fields; generated repositories reject caller-supplied bound fields, enforce policies before SQL pagination, and transact mutations. `inspect` and `schema` commands are local and need no token; native SQL remains privileged.

### Shared structure

- `domain.ts`: canonical values and errors.
- `resources.ts`: storage registration and selected generated operations.
- `contracts.ts`: native `Rpc.make` contracts grouped with `RpcGroup.make`; use explicit `Schema.toCodecJson` for non-JSON-native representations such as dates. Absent for generated-only applications.
- `application.ts`: resources and native `{ group, handlers }` bundle registration.
- `migrations/manifest.json`: ordered registry of frozen migration artifacts used at runtime.
- `migrations.ts`: decoded fixture/history data only where a seed or other local code needs it.
- `main.ts`: the sole runner for `serve`, schema commands, `inspect`, generated remote commands, and `worker` when background layers are configured.

`Application.make({ name, resources, commands })` groups optional resource/command arrays, including native `{ group, handlers }` bundles. Entrypoints pass `ApplicationBun.run(...)` to native `BunRuntime.runMain`. Table-bearing examples resolve `new URL("./migrations/manifest.json", import.meta.url)`; callers with decoded history may pass `{ migrations, filename? }`, and the workflow-only application uses empty history. Services, initialization, private `execution: { database, layer }`, native `background`, HTTP `routes`, and admin are explicit options. The runner supplies loopback RPC, CLI, schema commands, inspection, MCP, and opted-in admin. `*:server` scripts alias `main.ts serve`; the durable examples also have `*:worker` scripts. Admin uses prebuilt assets and never bundles at runtime.

## Generated admin

The seven resource-focused examples enable the optional admin server in `main.ts`; the durable examples do not. Build its browser assets first with `bun install` followed by `bun run build` at the repository root, then start an admin-enabled example and open `http://127.0.0.1:3000/admin` (or its configured port). The browser sources are [`client.ts`](admin/src/client.ts) and [`style.css`](admin/src/style.css); the native adapter is [`application-admin.ts`](../packages/effect-domains/src/application-admin.ts). It exposes only the application's published unary RPC operations; it does not infer permissions or bypass resource policy. Its in-process transport shares the RPC handlers, middleware, codecs, and request headers with the MCP server, and every protected call forwards and authenticates its bearer token independently.

The page keeps a manually entered bearer token in the browser's current memory only; it has no login, issuer, persistence, or token refresh. It builds scalar and structured forms from the RPC JSON schemas, hides forbidden fields, offers an entire-input JSON fallback for complex values, renders resource lists with declared filters and cursor next/back controls, and displays declared input/domain errors plus transport failures in the page.

`admin: true` uses `/admin`. A host can instead use the lower-level layer with presentation metadata:

```ts
ApplicationAdmin.layerHttp({
  application,
  javascript,
  stylesheet,
  path: "/operations",
  presentation: {
    title: "Library operations",
    resources: { books: { label: "Catalog", columns: ["id", "title"] } },
    operations: { "books.create": { label: "Add book", description: "Creates a catalog entry." } },
  },
})
```

The default Bun runner listens only on the loopback hostname. Admin browser calls must be same-origin; custom non-loopback hosts must explicitly name allowed origins with `allowedOrigins`. That allow-list validates trusted same-origin browser requests; it is not a CORS grant or a general cross-origin API.

## Authored SQL

[`authored-sql`](authored-sql/) preserves the custom book behavior separately from minimal generated CRUD. It reuses the canonical [`BookSchema`](../packages/example-support/src/book.ts), while its [`Resource.make`](authored-sql/resources.ts) uses `operations: []`: table derivation stays automatic, but no generated RPC handlers are published.

[`contracts.ts`](authored-sql/contracts.ts) declares JSON-native payload/success/error schemas directly with `Rpc.make` and exports `BooksRpcs`. [`sqlite.ts`](authored-sql/sqlite.ts) installs handlers with `BooksRpcs.toLayer`, using native `SqlClient` and `SqlSchema.findOne`, `findOneOption`, and `findAll`. Query failures are translated with explicit `Effect.catchTags`; missing-row domain errors are preserved. [`application.ts`](authored-sql/application.ts) registers `{ group: BooksRpcs, handlers: BooksSqlite }` directly, without a `Commands` service or a separate entrypoint service layer.

Unlike generated CRUD, missing rows report `BookNotFound`, database/query failures report `BookPersistenceError`, and `books.remove` returns the deleted row. List returns an array with no ordering or pagination guarantees.

Start the server:

```bash
bun run authored-sql:server
```

In another terminal:

```bash
bun run authored-sql books.create --title "A Field Guide" --page-count 120
bun run authored-sql books.list
```

Copy the returned UUIDv7 into `BOOK_ID`:

```bash
bun run authored-sql books.get --id "$BOOK_ID"
bun run authored-sql books.update --input-json "{\"id\":\"$BOOK_ID\",\"title\":\"A Revised Field Guide\",\"pageCount\":144}"
bun run authored-sql books.remove --id "$BOOK_ID"
bun run authored-sql inspect books.create
```

`AUTHORED_SQL_DB` defaults to `authored-sql.sqlite`; `AUTHORED_SQL_URL` defaults to `http://127.0.0.1:3000/rpc/v1`, and `PORT` defaults to `3000`. Set distinct ports and matching URLs to run alongside basic CRUD. Its independent [migration manifest](authored-sql/migrations/manifest.json) retains the same frozen initial book-table artifact; startup does not reset rows or adopt untracked databases. Review later changes with `bun run authored-sql schema generate <name>`.

## Reservation application

The [reservation guide](reservations/README.md) covers the business-policy slice: generated read operations alongside explicit transactional reserve, confirm, and release commands. It includes the stock walkthrough, transition errors, restart behavior, and historical timestamp migration. The [validation record](../docs/wiki/validation-strategy.md#reservation-slice) separates exercised behavior from unresolved framework questions.

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
ORDERS_INVOICES_TOKEN=bob-demo bun run orders-invoices orders.get --id "$ORDER_ID"
bun run orders-invoices inspect
```

The paid invoice has version 2. Repeating a mutation with its old version returns `VersionConflict`; re-paying the current paid version returns `InvalidInvoiceTransition`. Readers can query but cannot mutate. Another tenant can reuse `SO-1` or `INV-1` but cannot access or attach a line to this order. Foreign keys also enforce the tenant boundary for privileged SQL.

Amounts are checked safe-integer minor units. Empty orders cannot be invoiced; duplicate numbers, duplicate line numbers, arithmetic overflow, invalid transitions, and stale writes have declared errors. Payment records a local transition, not a payment-provider call. Taxes, currencies, credit notes, production identity, and request-idempotent retries are not implemented; fetch the current summary and make an explicit decision after a conflict.

`ORDERS_INVOICES_DB` defaults to `orders-invoices.sqlite`; `ORDERS_INVOICES_URL` defaults to `http://127.0.0.1:3000/rpc/v1`. Set `PORT` on the server and the matching client URL to run beside another example. Startup applies its frozen [initial manifest](orders-invoices/migrations/manifest.json), never resets data, and enables foreign keys. The generated admin is available at `/admin` after the shared build; enter a demo bearer token to use it. [Verification](../docs/wiki/validation-strategy.md#2026-09-09-tenant-scoped-orders-and-invoices) records live CLI/browser behavior and rollback/migration regressions.

## Durable workflows

[`durable-workflows`](durable-workflows/main.ts) registers a native Workflow and its proxy commands directly in the application. The workflow waits five seconds through `DurableClock`, optionally waits for a `DurableDeferred` approval, renders JSON in an Activity, and uses a SQL-backed `DurableQueue` worker to publish the artifact. Queue completion resumes the workflow; no custom jobs registry is involved. ([Workflow](durable-workflows/workflow.ts); [native layers](durable-workflows/runtime.ts); [writer](durable-workflows/writer.ts))

Start the server:

```bash
export DURABLE_WORKFLOWS_TOKEN=local-operator-secret
export DURABLE_WORKFLOWS_OUTPUT_DIR="$PWD/export-artifacts"
PORT=3001 bun run durable-workflows:server
```

In another terminal, configure the same token and submit:

```bash
export DURABLE_WORKFLOWS_TOKEN=local-operator-secret
export DURABLE_WORKFLOWS_URL=http://127.0.0.1:3001/rpc/v1
bun run durable-workflows DurableWorkflow.ExportDiscard --input-json '{"exportId":"demo-export","records":[{"id":"alice","name":"Alice","attributes":{"active":true}}],"requiresApproval":true}'
```

Set `EXECUTION_ID` to the returned execution ID, without its JSON quotes:

```bash
bun run durable-workflows DurableWorkflow.Poll --input-json "{\"executionId\":\"$EXECUTION_ID\"}"
bun run durable-workflows DurableWorkflow.Approve --input-json "{\"executionId\":\"$EXECUTION_ID\"}"
bun run durable-workflows DurableWorkflow.Poll --input-json "{\"executionId\":\"$EXECUTION_ID\"}"
bun run durable-workflows DurableWorkflow.Status
curl -H "Authorization: Bearer $DURABLE_WORKFLOWS_TOKEN" http://127.0.0.1:3001/operator/metrics
```

Poll again until `Succeeded`; success contains `artifactPath` and `recordCount`. `PendingOrUnknown` deliberately does not distinguish a pending/suspended execution from an unknown ID. `Export` waits for completion; `ExportDiscard` returns the stable execution ID. Repeating the same `exportId` targets the same execution: use a new ID for different input. An operator can explicitly request native resume with `DurableWorkflow.ExportResume` and the same execution-ID payload. Submission, resume, approval, polling, and status are authenticated; metrics independently requires the configured bearer token.

Application storage defaults to `durable-workflows.sqlite` (`DURABLE_WORKFLOWS_DB`); private native execution storage defaults to `durable-workflows-execution.sqlite` (`DURABLE_WORKFLOWS_EXECUTION_DB`). This example has no application tables and uses empty application history. Native Effect owns execution-table migrations.

To run without HTTP, stop the server and run `PORT=3001 bun run durable-workflows:worker` with the same database, output-directory, and token settings. Accepted executions continue after restart, including durable sleep and queue-backed file creation. Remote CLI/MCP calls require a running server; switch back to `serve` for approval or inspection of execution state.

## Durable reminders

[`durable-reminders`](durable-reminders/main.ts) uses one native Entity identity per recipient, not one actor per Resource. Persisted `Schedule` messages carry native `PrimaryKey` and `DeliverAt` protocols. Delivery records an application receipt transactionally, with `(recipient, requestId)` deduplication. A native Singleton writes a receipt projection every five seconds; a native ClusterCron archives receipts older than 90 days. This is a receipt-delivery demonstration, not an email/SMS integration. ([Protocol](durable-reminders/reminder-entity.ts); [registrations](durable-reminders/background.ts))

```bash
PORT=3002 bun run durable-reminders:server
```

In another terminal:

```bash
export DURABLE_REMINDERS_URL=http://127.0.0.1:3002/rpc/v1
export DURABLE_REMINDERS_TOKEN=admin-demo
REQUEST_ID=$(bun -e 'console.log(Bun.randomUUIDv7())')
DELIVER_AT=$(bun -e 'console.log(new Date(Date.now() + 30000).toISOString())')
bun run durable-reminders ReminderRecipient.ScheduleDiscard --input-json "{\"entityId\":\"alice\",\"payload\":{\"recipient\":\"alice\",\"requestId\":\"$REQUEST_ID\",\"message\":\"Review the export\",\"deliverAt\":\"$DELIVER_AT\"}}"
bun run durable-reminders reminder_receipts.list --filter-recipient alice
```

`ScheduleDiscard` acknowledges acceptance without waiting for delivery. `Schedule` takes the same envelope and waits for the receipt. Repeat a request with the same recipient, request ID, and payload to retrieve the existing result rather than deliver again. The handler rejects an `entityId` that differs from the payload recipient. Missing credentials fail authentication; valid non-admin demo sessions cannot schedule or read receipts.

Application storage defaults to `durable-reminders.sqlite` (`DURABLE_REMINDERS_DB`), with its frozen [initial migration](durable-reminders/migrations/001_initial.json). Private execution storage defaults to `durable-reminders.execution.sqlite` (`DURABLE_REMINDERS_EXECUTION_DB`). The projection defaults to `durable-reminders.receipts.json` (`DURABLE_REMINDERS_PROJECTION_FILE`). Retention runs at midnight UTC; `DURABLE_REMINDERS_RETENTION_CRON` explicitly overrides the native cron expression.

To exercise restart recovery, schedule a future message, stop the server, and start `PORT=3002 bun run durable-reminders:worker` with the same database and projection settings. The persisted delivery, singleton projection, and retention work continue without an HTTP listener. Switch back to `serve` to query receipts remotely.

### Durable execution boundaries

Both examples use native `SingleRunner`: run either `serve` or `worker` against an execution store, never both concurrently. Multi-runner topology requires an explicitly different native composition. Preserve both databases across restarts and back them up according to application recovery requirements; the runner rejects filename aliases, dangling symlinks, and ambiguous SQLite URI filenames before opening an execution-enabled runtime.

Application and execution transactions are separate. No cross-database transaction or automatic outbox is supplied. Retried external effects need explicit idempotency: the export writes the same execution-ID artifact through an atomic rename, while reminders deduplicate application receipt writes. Neither establishes exactly-once delivery to an arbitrary external service. Native Entity/Cron work explicitly captures application SQL during registration because Sharding supplies private execution SQL in its invocation context. ([Runtime contract](../docs/wiki/tables-and-queries.md#native-durable-execution); [verification and limits](../docs/wiki/validation-strategy.md#2026-09-09-native-durable-execution))

## CLI conventions

Scalar payload fields become kebab-case flags. Nested paths produce flags such as `--filter-completed` and `--changes-title`; patch identity is supplied as `--key`. Explicit false booleans are accepted as `--enabled false`; finite numeric fields have native flags, and use `--amount=-1` for negative numeric arguments. `--input-json` accepts the canonical JSON payload, including shapes that cannot be represented by native flags, and cannot be mixed with field flags. No-payload procedures require no input flags; empty struct payloads still decode as `{}`.

```bash
RESOURCE_CRUD_TOKEN=alice-demo bun run resource-crud todos.list --filter-completed false --limit 10
RESOURCE_CRUD_TOKEN=alice-demo bun run resource-crud todos.patch --key "$TODO_ID" --changes-title "Ship docs"
bun run reservations reserve --input-json '{"sku":"book","quantity":1}'
```

The endpoint uses Effect's JSON RPC protocol, not REST. Use the generated CLI or Effect's `RpcClient` rather than duplicating its envelope. Schema and business failures exit nonzero and report to stderr; successful results are JSON on stdout. Effect CLI parser errors may also print usage on stdout. `inspect [operation]` writes resource schemas, storage/physical fields, creation and list policies, local and remote commands, and selected operation contracts. Runtime requirements and authored transaction boundaries remain opaque metadata.

## MCP server

Every existing `serve` command also exposes Streamable HTTP MCP at `http://127.0.0.1:3000/mcp` (or the configured `PORT`). No extra application declarations or dependencies are needed:

```bash
bun run basic-crud:server
```

Configure your MCP client with that HTTP URL. It initializes an MCP session and discovers one tool per application RPC, using the unchanged operation name, such as `books.create`. `/rpc/v1` remains the separate Effect RPC endpoint used by the CLI.

Tool arguments are `{ "input": <RPC JSON payload> }`; successful structured content is `{ "result": <RPC JSON result> }`, also returned as JSON text. These object envelopes preserve scalar, array, and void contracts without guessing their meaning. Void uses `null`; an operation with an empty object payload, such as `books.list`, takes `{ "input": {} }`. After MCP initialization, a book creation call is:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "books.create",
    "arguments": { "input": { "title": "A Field Guide", "pageCount": 120 } }
  }
}
```

Protected operations use the same authenticator and resource policies as RPC. Configure the MCP client to send `Authorization: Bearer alice-demo` for the authenticated examples; an MCP session is not an identity, and every tool call is authenticated independently. Tool discovery exposes contracts without credentials, not protected row data. Declared domain and authorization failures return `isError: true` with their encoded JSON error; unexpected defects return a generic error without internal details.

The runtime negotiates MCP `2025-11-25`, `2025-06-18`, or `2025-03-26`. It rejects browser Origin headers by default. This is an HTTP tool server, not a stdio adapter, REST API, or inferred MCP resource/prompt interface. Custom Effect hosts can use `RpcMcp.layerHttp({ name, group, path })` from `effect-domains/rpc-mcp`, providing the group's handlers, middleware, and codec services. ([Adapter](../packages/effect-domains/src/rpc-mcp.ts); [Bun wiring](../packages/effect-domains/src/application-bun.ts))

### MCP client walkthrough

[`mcp-server`](mcp-server/) is a dedicated, public book catalog with a runnable MCP client. Its [resource declaration](mcp-server/resources.ts) generates the same five CRUD operations as basic CRUD; [the runner](mcp-server/main.ts) exposes them as MCP tools without hand-written tool schemas or handlers. It does not enable the browser admin, so no admin build is needed.

From the repository root:

```bash
bun install
bun run mcp-server:server
```

In another terminal:

```bash
bun run mcp-server:client
```

The [client](mcp-server/client.ts) uses the official `@modelcontextprotocol/sdk` Streamable HTTP transport inside a scoped Effect program. `connect` performs initialization; `listTools` prints the discovered input/output schemas. It then creates a book, reads it, updates it, lists books, and removes only the book it created. Finally, it reads the deleted ID to demonstrate `isError: true` with `ResourceNotFound`, terminates the MCP session, and closes the connection. Unexpected tool failures exit nonzero. An interrupted walkthrough can leave its newly created book in the database.

The create call illustrates the wire envelope:

```ts
await client.callTool({
  name: "books.create",
  arguments: { input: { title: "MCP Field Guide", pageCount: 120 } },
})
```

Success includes `structuredContent.result` and equivalent JSON text; the client decodes the created row with its Effect Schema to obtain the generated UUID. List takes `{ input: {} }` and returns an array under `result`; removal returns `{ result: null }`. A declared domain error is returned as tool content, not thrown as a transport exception.

To use a coding agent or another MCP client instead, configure **Streamable HTTP** with URL `http://127.0.0.1:3000/mcp`. No token is required for this explicitly public example. The generated CLI remains available separately:

```bash
bun run mcp-server books.list
bun run mcp-server inspect books.create
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `MCP_SERVER_DB` | `mcp-server.sqlite` | Persistent application database |
| `PORT` | `3000` | Loopback server port |
| `MCP_SERVER_MCP_URL` | `http://127.0.0.1:3000/mcp` | Walkthrough client endpoint |
| `MCP_SERVER_URL` | `http://127.0.0.1:3000/rpc/v1` | Generated CLI endpoint, not MCP |

For a second server, set `PORT=3003` on the server and `MCP_SERVER_MCP_URL=http://127.0.0.1:3003/mcp` on the walkthrough client. Startup applies its own frozen [migration manifest](mcp-server/migrations/manifest.json); it does not reset existing rows. Keep this unauthenticated example on loopback. For protected MCP operations, use the tenant/owner or role-policy applications described above.

## Review schema changes

Schema commands run locally without a server. After changing a resource schema, `schema generate <name>` plans the next artifact from the registered manifest, writes that artifact, then atomically replaces the manifest registry only if the plan is valid:

```bash
bun run migration-lifecycle schema generate add-status \
  --backfill 'documents:status:"draft"'
```

Use `schema snapshot` or `schema plan` to inspect a prospective artifact without registering it:

```bash
bun run reservations schema snapshot --out current-schema.json
bun run reservations schema plan --id 004_change \
  --from apps/reservations/migrations/003_schema_string_checks.json \
  --out 004_change.json
```

`generate` numbers the new artifact after the final registered migration; it requires a manifest and leaves the registry unchanged when a plan is blocked. Review the generated artifact and its manifest update as one change. Do not regenerate previously applied artifacts from current models.

Intent flags use physical table and column names. Each flag is repeatable; JSON values and SQL expressions retain embedded colons. Rename sources must exist in the physical `from` snapshot:

| Flag | Meaning |
| --- | --- |
| `--rename table:old:new` | Explicit column rename |
| `--backfill 'table:column:JSON'` | Constant stored value for a new required field |
| `--transform 'table:column:SQL-expression'` | Explicit stored-value transformation |

A transform runs in the `SELECT` over the physical **from** table, before renames or rebuilding. The checked-in [timestamp artifact](reservations/migrations/002_timestamp.json) converts historical epoch seconds to ISO text. Its snapshot does not import the latest reservation schema.

Rename chains and cycles also copy original source columns through a transactional rebuild. The todo, document, and reservation manifests append `003_schema_string_checks` to remove previously misderived SQLite string-length constraints while preserving rows. Canonical string checks remain enforced by schemas; historical artifacts are not rewritten.

The planner emits blocked changes with their reasons instead of guessing drops, renames, or required values. The runtime checks manifest history and actual table definitions, applies rebuilds transactionally, and refuses untracked tables, indexes, and triggers. Declared unique/foreign-key changes rebuild tables; declared secondary indexes have explicit create/drop steps. Existing data must satisfy the target constraints or the migration rolls back. Destructive table/column drops, arbitrary custom objects, cascade policy, and inferred joins remain outside the current model. ([Relational contract](../docs/wiki/tables-and-queries.md#relational-storage-declarations))

## Framework code map

- [`ApplicationBun`](../packages/effect-domains/src/application-bun.ts): shared HTTP server and CLI runtime.
- [`Resource`](../packages/effect-domains/src/resource.ts): generated repositories, selected RPC contracts, groups, and handlers.
- [`Authorization`](../packages/effect-domains/src/authorization.ts): typed resource policy declarations and evaluator.
- [`AuthorizationRpc.Authenticator`](../packages/effect-domains/src/authorization-rpc.ts): request-local verified identity boundary; [demo implementation](../packages/example-support/src/authentication.ts).
- [Authored SQL](authored-sql/sqlite.ts): Effect `SqlSchema` request/result codecs and native `SqlClient` access.
- [`RpcCli`](../packages/effect-domains/src/rpc-cli.ts): schema-derived CLI flags and JSON fallback.
- [`SqliteMigrations`](../packages/effect-domains/src/sqlite-migrations.ts): frozen snapshots, migration planning, and execution.
