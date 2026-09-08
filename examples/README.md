# Examples

Each example is a complete, loopback-only application with a persistent SQLite database, a manifest registry of frozen migration artifacts, an HTTP RPC server, a generated CLI, and local schema commands. They demonstrate different framework boundaries rather than seven copies of the same CRUD implementation.

## Choose an application

| Application | Purpose | Database setting |
| --- | --- | --- |
| [basic-crud](basic-crud/README.md) | Minimal book CRUD generated from one resource declaration | `BASIC_CRUD_DB` |
| [authored-sql](#authored-sql) | Custom book contracts and authored SQL with Effect `SqlSchema` | `AUTHORED_SQL_DB` |
| [resource-crud](resource-crud/README.md) | Todo CRUD generated from a resource, including page/list and patch policies | `RESOURCE_CRUD_DB` |
| [service-codec](service-codec/README.md) | Generated note CRUD with a runtime-service-dependent storage codec | `SERVICE_CODEC_DB` |
| [persisted-ref](persisted-ref/README.md) | A shared counter bound to one persisted resource identity with explicit refresh | `PERSISTED_REF_DB` |
| [migration-lifecycle](migration-lifecycle/README.md) | Document CRUD with historical rename and backfill | `MIGRATION_LIFECYCLE_DB` |
| [reservations](reservations/README.md) | Explicit stock policy and transactional reservation commands | `RESERVATIONS_DB` |

The guides explain what is generated, what is deliberately authored, how to run each application, and its limitations. Start with [basic-crud](basic-crud/README.md); [resource-crud](resource-crud/README.md) adds defaults, pagination, and patch policy. [Authored SQL](#authored-sql) demonstrates the escape hatch.

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

Client settings follow the database naming convention: `BASIC_CRUD_URL`, `AUTHORED_SQL_URL`, `RESOURCE_CRUD_URL`, `SERVICE_CODEC_URL`, `PERSISTED_REF_URL`, `MIGRATION_LIFECYCLE_URL`, and `RESERVATIONS_URL`. There is no authentication. These are runnable examples, not production deployment templates.

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
bun run resource-crud todos.list --filter-completed false --limit 10
bun run resource-crud todos.patch --id "$TODO_ID" --patch-title "Ship docs"
bun run reservations reserve --input-json '{"sku":"book","quantity":1}'
```

The endpoint uses Effect's JSON RPC protocol, not REST. Use the generated CLI or Effect's `RpcClient` rather than duplicating its envelope. Schema and business failures exit nonzero and report to stderr; successful results are JSON on stdout. Effect CLI parser errors may also print usage on stdout. `inspect [operation]` writes resource schemas, storage/physical fields, creation and list policies, local and remote commands, and selected operation contracts. Runtime requirements and authored transaction boundaries remain opaque metadata.

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
- [Authored SQL](authored-sql/sqlite.ts): Effect `SqlSchema` request/result codecs and native `SqlClient` access.
- [`RpcCli`](../src/rpc-cli.ts): schema-derived CLI flags and JSON fallback.
- [`SqliteMigrations`](../src/sqlite-migrations.ts): frozen snapshots, migration planning, and execution.
