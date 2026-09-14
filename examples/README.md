# Example applications

Each application solves a concrete record-keeping or operational problem. Every example has a standalone walkthrough; this page records conventions shared across them.

## Choose an application

| Application | Useful scenario | Principal boundary |
| --- | --- | --- |
| [reading-list](reading-list/README.md) | Maintain a reading backlog and ratings | Generated CRUD, implicit `null` defaults, and cursor lists |
| [expense-ledger](expense-ledger/README.md) | Record expenses and review totals by currency | Domain value schemas and authored range queries |
| [team-tasks](team-tasks/README.md) | Track project work and completion | Tenant/owner scope and reusable subject policies |
| [field-notes](field-notes/README.md) | Share encrypted site observations | Role policy independent of storage encryption |
| [editorial-calendar](editorial-calendar/README.md) | Plan articles by channel and publication date | Version-2 migration history and rebuild copies |
| [equipment-register](equipment-register/README.md) | Register and inspect equipment through MCP | Unique tags and generated tool contracts |
| [repair-workshop](repair-workshop/README.md) | Track customer repairs and assignments | `ReadModel` joined reads and bounded projections |
| [support-cases](support-cases/README.md) | Triage, assign, and resolve customer cases | A second joined view, versioned transitions, and authored event history |
| [reservations](reservations/README.md) | Hold, confirm, or release stock | `Transitions.make` and transactional inventory |
| [orders-invoices](orders-invoices/README.md) | Build an order, issue an invoice, and record payment | Nested application composition, scoped relations, and optimistic versions |
| [purchased-guides](purchased-guides/README.md) | Read a guide unlocked by a purchase | `Entitlements.fromTable` after row visibility |
| [report-exports](report-exports/README.md) | Approve and publish a financial JSON report | Subscription gating and durable execution storage |
| [appointment-reminders](appointment-reminders/README.md) | Schedule an application notification | Durable scheduling and deduplicated delivery |

## Shared runtime

Run commands from the repository root:

```bash
bun install
bun run build
bun run reading-list:server
```

Servers default to `http://127.0.0.1:3000`; the generated CLI defaults to `http://127.0.0.1:3000/rpc/v1`. Set `PORT` on the server and `<APP>_URL` on the client when using another port. Application names become uppercase underscore prefixes: `READING_LIST_DB`, `TEAM_TASKS_TOKEN`, and so on. Application databases default to `data/<application>.sqlite`.

### Demonstration identity

Team tasks, field notes, orders/invoices, purchased guides, report exports, and appointment reminders provide issued-session identity. Configure a protected example with its own identity database:

```bash
export EFFECT_DOMAINS_DEMO_PASSWORD='choose-a-local-bootstrap-password'
export TEAM_TASKS_IDENTITY_DB="$(mktemp -d)/team-tasks-identity.sqlite"
```

`SqliteIdentity.layer({ application: "team-tasks", ... })` derives `TEAM_TASKS_IDENTITY_DB`; the default is `data/team-tasks-identity.sqlite`. Never set it to the application database. Seeded accounts are Alice (Acme editor), Bob (Acme reader), Admin (Acme administrator), and Outsider (other-tenant editor). They are demonstration bootstrap data, not a user-management or IdP implementation.

After setting `<APP>_URL`, acquire a token through `identity.login`:

```bash
export TEAM_TASKS_TOKEN="$(
  bun run team-tasks identity.login --input-json "$(
    bun -e 'console.log(JSON.stringify({ username: "alice", password: process.env.EFFECT_DOMAINS_DEMO_PASSWORD }))'
  )" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).token)'
)"
```

Treat it as a secret. The CLI sends `<APP>_TOKEN` as a bearer credential. `identity.current` returns its verified subject and expiry; `identity.logout` revokes it. `EFFECT_DOMAINS_SESSION_LIFETIME` defaults to eight hours. Account seeding inserts missing accounts and preserves changed account state.

### Durable execution storage

Report exports and appointment reminders have separate native execution stores. `SqliteBunRuntime.privateClient({ application, purpose: "execution" })` uses `<APP>_EXECUTION_DB`, defaulting to `data/<application>-execution.sqlite`, and rejects the application database file or inode. `EFFECT_CLUSTER_MODE` selects default local `single`, Bun HTTP `runner`, or client-only `client` execution. Multiple runners are supported only as colocated processes sharing one execution SQLite file; use distinct advertised/listen ports and follow each application's topology-upgrade runbook.

## Shared structure

- `domain.ts`: canonical values, brands, and domain errors; use framework schemas such as `UuidV7Schema`, `SafeIntSchema`, and `PageLimitSchema`, and use `Schema.DateTimeUtc` for canonical timestamps.
- `resources.ts`: resource schemas, policies, relation declarations, generated operations, versions, and transitions.
- `sqlite.ts` where needed: `Command` specifications, implementations, and authored SQL for cross-record rules, aggregates, and projections.
- `application.ts`: `Application.define({ name, parts })` with explicit `Part.resource`, `Part.command`, `Part.native`, and `Part.application` syntax, followed by `Application.compile`.
- `migrations.ts`: frozen JSON imports passed to `SqliteMigrations.history(...)`.
- `main.ts`: `ApplicationBun.run` builds the native entrypoint `Effect`; `ApplicationBun.runMain` exposes the native Bun boundary without requiring an example-level platform import. `StaticSpa.layerHttp` validates and mounts the authored static-site declaration.
- `web/`: a Foldkit SPA started by effectful `BrowserRuntime.run` at the explicit `Effect.runSync` browser boundary, using `RpcBrowser` over the published contracts. Shared HTML/session rendering remains in example-web; transport, paging, identity command mapping, startup, and asset routes are framework modules.

`Command.define` owns inspectable JSON contracts, policy, transaction mode, and ReadModel dependencies; `Command.implement` attaches the authored Effect handler. `Command.bundle(...)` produces a command part. Derived joined pages publish through `ReadModel.publish`.

## Generated resource conventions

Nullable (`Schema.NullOr`) fields default to `null` when omitted on create. Do not add `defaults: { field: null }` just for that behavior.

A versioned resource has `version: "version"`. Its patch request is `{ key, expectedVersion, changes }`; stale writes return `VersionConflict`. A transition resource publishes `<resource>.transition` with `{ key, action, changes? }`, adding `expectedVersion` when versioned; local handlers use `repository.transition(key, action, changes?, expectedVersion?)`.

Use `repository.ensure(row)` for every seed. It inserts by identifier only when absent, otherwise returns an existing read-authorized row. A declared unique relation reports `UniqueViolation { resource, constraint, fields }`; translate it to a domain error only where that domain needs one.

Generated lists return `{ items, nextCursor }`. A declaration can name equality `filter` fields, inclusive `range` fields, a `limit`, and a stable `order`:

```ts
list: {
  filter: ["status"],
  range: ["scheduledAt"],
  order: [["scheduledAt", "asc"]],
  limit: 25,
}
```

The input accepts `{ filter?, range?, limit?, cursor? }`; a range has `{ from?, to? }` bounds and both are inclusive. The identifier is appended to declared order as a tiebreaker. Return a non-null cursor unchanged with the same filter and range.

Relation names are derived in snake case (`<table>_<fields>_key|_fkey|_idx`). A foreign-key `scope: ["tenantId"]` expands the tenant field on both local and referenced sides. Keep an explicit name only if a frozen artifact requires a different name.

## Migration artifacts

There is no schema CLI or inferred planner. A v2 artifact is `{ id, to, steps }`; it has no `from`. Import artifacts and call `SqliteMigrations.history(...)`, which derives each preceding snapshot from history.

`CreateTable`, `RebuildTable`, and `CreateIndex` steps name objects in the artifact's `to` snapshot. A rebuild uses explicit copies only for renamed, changed, or backfilled columns; unchanged common columns copy by identity. Use `SqliteMigrations.initial({ id, tables })` for a new history, then append reviewed artifacts. Replay the complete history against representative old rows in a disposable database before normal startup.

## CLI and MCP conventions

Operation input is canonical JSON through `--input-json`; there are no generated field flags. Success is JSON on stdout; schema, domain, authorization, and transport failures exit nonzero. The endpoint is Effect JSON RPC, not REST.

MCP tool arguments are `{ "input": <RPC JSON payload> }`. A structured success is `{ "result": <RPC JSON result> }`; declared failures return `isError: true`. Protected tools require a real bearer credential on every call.
