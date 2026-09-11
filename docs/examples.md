---
description: Choose a runnable application for CRUD, authorization, migrations, authored business rules, or durable work.
---

# Choose an example

Start with the application closest to the problem you need to solve. Each example owns its domain schema, resource configuration, and runtime entrypoint; you can compare them without tracing one large demonstration application.

Run commands from the repository root after `bun install`. Run `bun run build` before starting examples that enable the browser admin. Keep demonstration servers on loopback: their public access and fixed demo tokens are not production authentication.

## Start with records

| Application | What to look for | Start here |
| --- | --- | --- |
| Reading list | Generated CRUD, nullable creation defaults, status/format filters | [First-run tutorial](/getting-started) |
| Team tasks | Tenant scope, ownership, trusted identity fields, completed-task edit restrictions | [Authorization guide](/guides/authorization) |
| Editorial calendar | Stored rows surviving column changes and explicit backfills | [Migration guide](/guides/migrations) |
| Field notes | Role-based access with encrypted report text at rest | [Source walkthrough](../examples/field-notes/README.md) |

The first three have walkthroughs on this site. For any example, `bun run <application> --help` lists its commands and `bun run <application> inspect` describes its contracts without starting the server. The folder names in the table correspond to `reading-list`, `team-tasks`, `editorial-calendar`, and `field-notes`.

## Go beyond generated CRUD

### Expense ledger

Use this when an operation is a query or calculation, not just a record list. The application records integer minor-unit amounts and calculates category totals separately for each currency. Its date-range query has its own ordering and bounds.

Start `bun run expense-ledger:server`, then use the [record/query/totals walkthrough](../examples/README.md#expense-ledger). Read [`contracts.ts`](../examples/expense-ledger/contracts.ts) beside [`sqlite.ts`](../examples/expense-ledger/sqlite.ts) to see native Effect RPC contracts and authored SQL working with generated repositories.

### Reservations

Use this when an action must preserve an invariant across multiple writes. Reserving, confirming, and releasing stock are authored transactional operations; generated resource operations are read-only.

The [reservation walkthrough](../examples/reservations/README.md) covers stock reads, valid transitions, transition errors, and persistence. Compare the [resources](../examples/reservations/resources.ts) with the [handlers](../examples/reservations/sqlite.ts): unrestricted CRUD would bypass the stock-accounting rules.

### Orders and invoices

Use this for tenant-scoped relations, uniqueness constraints, optimistic versions, and multi-record transactions. The application builds an order, issues an invoice, and records payment.

Follow the [billing walkthrough](../examples/README.md#orders-and-invoices). Storage relations live in [`resources.ts`](../examples/orders-invoices/resources.ts); business transitions live in [`sqlite.ts`](../examples/orders-invoices/sqlite.ts), not in schema annotations.

## Connect an MCP client

### Equipment register

This public example exposes equipment records as generated MCP tools. It has no browser admin and needs no admin build.

In one terminal:

```bash
bun run equipment-register:server
```

In another:

```bash
bun run equipment-register:client
```

The SDK client discovers tools, registers a camera, moves it, filters equipment, retires the camera, and removes the record it created. An interrupted run can leave that record behind.

If port 3000 is occupied, start the server with `PORT=3004` and run the client with `EQUIPMENT_REGISTER_MCP_URL=http://127.0.0.1:3004/mcp`. This is the MCP URL, not the CLI’s `/rpc/v1` endpoint.

Read the [SDK client](../examples/equipment-register/client.ts) or the [MCP contract](/reference/runtime#mcp-tools) to integrate your own client.

## Check current entitlements

### Purchased guides

Use this when an authorized user also needs a current grant for one specific resource. The application checks a persisted guide purchase after tenant and role checks. A missing purchase produces `EntitlementRequired`; a grant does not bypass row visibility.

The [purchased-guides walkthrough](../examples/README.md#purchased-guides) contrasts an unlocked guide, a locked guide, and a guide in another tenant. It also explains why a list containing a locked visible guide fails rather than silently returning a shorter page. There is no payment-provider or checkout integration.

## Durable work

These examples use native Effect durable execution, composed through application-provided layers. Each has an application database and a separate execution database. Run either `serve` or `worker` against one execution store, **not both at once**.

### Report exports

Use this for work that waits for approval and then publishes a file. The workflow takes supplied financial lines, enforces account subscription access on generation, waits for an operator when requested, and writes a JSON report artifact.

The [report walkthrough](../examples/README.md#report-exports) supplies the output directory, demo credentials, generation payload, release command, and polling loop. Acceptance of an execution is not completion; wait for `Succeeded` and inspect the returned artifact path. It does not query a separate accounting system or provide a payment integration.

### Appointment reminders

Use this for durable scheduling and deduplicated application-side delivery. The example schedules an appointment reminder and later inserts a notification into an application inbox. It does not send email or SMS.

The [reminder walkthrough](../examples/README.md#appointment-reminders) creates future timestamps, submits a reminder, and reads the inbox after delivery. It also shows how to stop the server and continue accepted work in worker mode.

Application and execution transactions are separate. These examples do not establish exactly-once behavior for arbitrary external services.

## Navigate the source

Most examples use this layout:

| File | Read it to understand |
| --- | --- |
| `domain.ts` | Canonical values and errors |
| `resources.ts` | Persistence, authorization, and generated operations |
| `contracts.ts` | Authored native RPC input/success/error contracts, where needed |
| `sqlite.ts` | Authored handlers and SQL, where needed |
| `application.ts` | Composition of resource and authored operations |
| `migrations.ts` | Ordered imports of frozen migration artifacts |
| `main.ts` | Runtime service wiring and admin opt-in |

For shared command options, see [runtime and clients](/reference/runtime). For dated verification and its limits, see the [validation record](/wiki/validation-strategy).
