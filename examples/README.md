# Examples

Each example is a complete, loopback-only application with a persistent SQLite database, a manifest registry of frozen migration artifacts, an HTTP RPC server, a generated CLI, and local schema commands. They demonstrate different framework boundaries rather than seven copies of the same CRUD implementation.

## Choose an application

| Application | Purpose | Database setting |
| --- | --- | --- |
| [basic-crud](basic-crud/README.md) | Minimal book CRUD generated from one resource declaration | `BASIC_CRUD_DB` |
| [authored-sql](#authored-sql) | Custom book contracts and authored SQL with Effect `SqlSchema` | `AUTHORED_SQL_DB` |
| [resource-crud](resource-crud/README.md) | Tenant/owner todo policies, completion locks, pagination, and patch | `RESOURCE_CRUD_DB` |
| [service-codec](service-codec/README.md) | Reader/editor/admin note permissions alongside a service-dependent storage codec | `SERVICE_CODEC_DB` |
| [persisted-ref](persisted-ref/README.md) | A shared counter bound to one persisted resource identity with explicit refresh | `PERSISTED_REF_DB` |
| [migration-lifecycle](migration-lifecycle/README.md) | Document CRUD with historical rename and backfill | `MIGRATION_LIFECYCLE_DB` |
| [reservations](reservations/README.md) | Explicit stock policy and transactional reservation commands | `RESERVATIONS_DB` |

The guides explain what is generated, what is deliberately authored, how to run each application, and its limitations. Start with [basic-crud](basic-crud/README.md); compare [tenant/owner todo rules](resource-crud/resources.ts) with [role-based note rules](service-codec/resources.ts) to see custom authorization. [Authored SQL](#authored-sql) demonstrates the privileged escape hatch.

## Shared runtime

Install dependencies once with `bun install`.

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

Client settings follow the database naming convention: `BASIC_CRUD_URL`, `AUTHORED_SQL_URL`, `RESOURCE_CRUD_URL`, `SERVICE_CODEC_URL`, `PERSISTED_REF_URL`, `MIGRATION_LIFECYCLE_URL`, and `RESERVATIONS_URL`. Todo and note RPCs require the demo credentials below; the other five examples remain explicitly public. These are runnable loopback examples, not production deployment templates.

### Demo authentication

[`authentication.ts`](authentication.ts) supplies one small `Authenticator` layer to the todo and note applications. It resolves an exact bearer token to server-owned subject claims; missing or unknown tokens fail with `Unauthenticated`. It does not accept user, tenant, or role claims from caller headers.

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
  --tenant-id acme --owner-id alice --title "Ship authorization examples"
SERVICE_CODEC_TOKEN=alice-demo bun run service-codec notes.create --id example-note --text "Shared notes"
```

Todo policies combine tenant scope, ownership, current completion state, immutable ownership, and admin-only removal. `outsider-demo` deliberately has Alice's user ID in another tenant, demonstrating that ownership alone does not grant access. Existing todos migrate to tenant `acme`, owner `alice`; this is explicit demo backfill intent, not an inferred ownership rule.

Notes instead form one global shared collection: readers can read, editors can create/update, and admins can also remove. Tenant claims do not partition this collection. The storage codec remains independent of authorization. Follow each guide for successful and denied operations.

Policy is declared in `resources.ts`, not in canonical schemas or per-operation handlers. Generated repositories enforce it before SQL pagination and transactionally around mutations. `inspect` and `schema` commands are local and need no token; native SQL remains privileged.

### Shared structure

- `domain.ts`: canonical values and errors.
- `resources.ts`: storage registration and selected generated operations.
- `contracts.ts`: authored native RPCs using `Commands.rpc` for automatic JSON codecs, grouped with `RpcGroup.make`; absent for generated-only applications.
- `application.ts`: resources and explicit command-descriptor registration.
- `migrations/manifest.json`: ordered registry of frozen migration artifacts used at runtime.
- `migrations.ts`: decoded fixture/history data only where a seed or other local code needs it.
- `main.ts`: the sole runner for `serve`, schema commands, `inspect`, and generated remote commands.

`Application.make({ name, resources, commands: [descriptor] })` combines resource and command-descriptor groups; absent groups use empty arrays. `main.ts` resolves the manifest to an absolute path and calls `ApplicationBun.run(app, { database: { manifest, filename: Option.none() }, services, initialize })`; callers owning decoded history may instead pass `database: { migrations, filename: Option.none() }`. Use `Layer.empty` for no authored services and `Effect.void` for no initialization. The same runner supplies the loopback server, generated RPC client, local schema commands, and inspection; `*:server` scripts alias `main.ts serve`. Authored applications pass native RPC groups to `Commands.make({ name, group })` and install implementations with `descriptor.layer(handlers)`.

## Authored SQL

[`authored-sql`](authored-sql/) preserves the custom book behavior separately from minimal generated CRUD. It reuses the canonical [`BookSchema`](basic-crud/domain.ts), while its [`Resource.make`](authored-sql/resources.ts) uses `operations: []`: table derivation stays automatic, but no generated RPC handlers are published.

[`contracts.ts`](authored-sql/contracts.ts) declares explicit payload/success/error schemas with `Commands.rpc`, which derives JSON codecs and returns native Effect RPCs. [`sqlite.ts`](authored-sql/sqlite.ts) installs `BooksService.layer` handlers using native `SqlClient` and `SqlSchema.findOne`, `findOneOption`, and `findAll`. Query behavior and error translation remain authored.

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

## CLI conventions

Scalar payload fields become kebab-case flags. Nested payload fields use their path, so `filter.completed` is `--filter-completed` and `patch.title` is `--patch-title`. Explicit false booleans are accepted as `--enabled false`; finite numeric fields have native flags, and use `--amount=-1` for negative numeric arguments. `--input-json` accepts the canonical JSON payload, including shapes that cannot be represented by native flags. It cannot be mixed with field flags.

```bash
RESOURCE_CRUD_TOKEN=alice-demo bun run resource-crud todos.list --filter-completed false --limit 10
RESOURCE_CRUD_TOKEN=alice-demo bun run resource-crud todos.patch --id "$TODO_ID" --patch-title "Ship docs"
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

The runtime negotiates MCP `2025-11-25`, `2025-06-18`, or `2025-03-26`. It rejects browser Origin headers by default. This is an HTTP tool server, not a stdio adapter, REST API, or inferred MCP resource/prompt interface. Custom Effect hosts can use `RpcMcp.layerHttp({ name, group, path })` from `effect-domains/rpc-mcp`, providing the group's handlers, middleware, and codec services. ([Adapter](../src/rpc-mcp.ts); [Bun wiring](../src/application-bun.ts))

## Review schema changes

Schema commands run locally without a server. After changing a resource schema, `schema generate <name>` plans the next artifact from the registered manifest, writes that artifact, then atomically replaces the manifest registry only if the plan is valid:

```bash
bun run migration-lifecycle schema generate add-status \
  --backfill 'documents:status:"draft"'
```

Use `schema snapshot` or `schema plan` to inspect a prospective artifact without registering it:

```bash
bun run reservations schema snapshot --out current-schema.json
bun run reservations schema plan --id 003_change \
  --from examples/reservations/migrations/002_timestamp.json \
  --out 003_change.json
```

`generate` numbers the new artifact after the final registered migration; it requires a manifest and leaves the registry unchanged when a plan is blocked. Review the generated artifact and its manifest update as one change. Do not regenerate previously applied artifacts from current models.

Intent flags use physical table and column names:

| Flag | Meaning |
| --- | --- |
| `--rename table:old:new` | Explicit column rename |
| `--backfill 'table:column:JSON'` | Constant stored value for a new required field |
| `--transform 'table:column:SQL-expression'` | Explicit stored-value transformation |

A transform runs in the `SELECT` over the physical **from** table, before renames or rebuilding. The checked-in [timestamp artifact](reservations/migrations/002_timestamp.json) converts historical epoch seconds to ISO text. Its snapshot does not import the latest reservation schema.

The planner emits blocked changes with their reasons instead of guessing drops, renames, or required values. The runtime checks manifest history and actual table definitions, applies rebuilds transactionally, and refuses untracked tables, indexes, and triggers. Relationships, indexes, destructive drops, and arbitrary custom table objects are outside the current migration model.

## Framework code map

- [`ApplicationBun`](../src/application-bun.ts): shared HTTP server and CLI runtime.
- [`Resource`](../src/resource.ts): generated repositories, selected RPC contracts, groups, and handlers.
- [`Authorization`](../src/authorization.ts): typed resource policy declarations and evaluator.
- [`Authenticator`](../src/authorization-rpc.ts): request-local verified identity boundary; [demo implementation](authentication.ts).
- [Authored SQL](authored-sql/sqlite.ts): Effect `SqlSchema` request/result codecs and native `SqlClient` access.
- [`RpcCli`](../src/rpc-cli.ts): schema-derived CLI flags and JSON fallback.
- [`SqliteMigrations`](../src/sqlite-migrations.ts): frozen snapshots, migration planning, and execution.
