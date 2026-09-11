---
description: Choose a runnable application for CRUD, authorization, migrations, authored business rules, or durable work.
---

# Choose an example

Each of the twelve applications has its own detailed guide beside its source. Choose a domain below, then follow its setup, CLI workflow, expected failures, and storage/authentication notes. Shared conventions live in the [example index](../examples/README.md).

Run commands from the repository root after `bun install`. Run `bun run build` before serving **any** example: every application needs its prebuilt Foldkit frontend, and some also enable generated admin. Keep demonstration servers on loopback; public access and fixed demo tokens are not production authentication.

## Start with records

| Application guide | What to look for | Related framework guide |
| --- | --- | --- |
| [Reading list](../examples/reading-list/README.md) | Generated CRUD, nullable creation defaults, status/format filters | [First-run tutorial](/getting-started) |
| [Team tasks](../examples/team-tasks/README.md) | Tenant scope, ownership, trusted identity fields, completed-task edit restrictions | [Authorization guide](/guides/authorization) |
| [Editorial calendar](../examples/editorial-calendar/README.md) | Stored rows surviving column changes and explicit backfills | [Migration guide](/guides/migrations) |
| [Field notes](../examples/field-notes/README.md) | Global role-based access with encrypted report text at rest | [Authorization guide](/guides/authorization) |

For any example, `bun run <application> --help` lists its commands and `bun run <application> inspect` describes its contracts without starting the server.

## Go beyond generated CRUD

### Expense ledger

Use this when an operation is a query or calculation, not just a record list. The application records integer minor-unit amounts and calculates category totals separately for each currency. Its date-range query has its own ordering and bounds.

Follow the [expense-ledger guide](../examples/expense-ledger/README.md) to record two currencies, query inclusive date bounds, compare totals, and correct or remove an entry. Read [`contracts.ts`](../examples/expense-ledger/contracts.ts) beside [`sqlite.ts`](../examples/expense-ledger/sqlite.ts) to see native Effect RPC contracts and authored SQL working with generated repositories.

### Repair workshop

Use this for a board that joins repairs to current customer and optional technician records. The [repair-workshop guide](../examples/repair-workshop/README.md) creates assigned and unassigned jobs, changes joined names and on-call values, contrasts bounded arrays with cursor pages, and exercises foreign-key failures.

[`board.ts`](../examples/repair-workshop/board.ts) declares the projection and joins with `SqliteView`; [`sqlite.ts`](../examples/repair-workshop/sqlite.ts) still owns filtering, ordering, bounds, and errors. Status values are editable records, not guarded workflow transitions.

### Reservations

Use this when an action must preserve an invariant across multiple writes. Reserving, confirming, and releasing stock are authored transactional operations; generated resource operations are read-only.

The [reservation walkthrough](../examples/reservations/README.md) covers stock reads, valid transitions, transition errors, and persistence. Compare the [resources](../examples/reservations/resources.ts) with the [handlers](../examples/reservations/sqlite.ts): unrestricted CRUD would bypass the stock-accounting rules.

### Orders and invoices

Use this for tenant-scoped relations, uniqueness constraints, optimistic versions, and multi-record transactions. The application builds an order, issues an invoice, and records payment.

Follow the [orders-and-invoices guide](../examples/orders-invoices/README.md) for the complete order/line/invoice/payment sequence, exact versions, and role/tenant failures. Storage relations live in [`resources.ts`](../examples/orders-invoices/resources.ts); business transitions live in [`sqlite.ts`](../examples/orders-invoices/sqlite.ts), not in schema annotations.

## Connect an MCP client

### Equipment register

This public example exposes equipment records as generated MCP tools. Its [equipment-register guide](../examples/equipment-register/README.md) runs the official SDK client through discovery, creation, relocation, retirement, and removal, then repeats the lifecycle through the CLI.

It has no generated admin, but still needs `bun run build` for its Foldkit page. The guide distinguishes `EQUIPMENT_REGISTER_MCP_URL` (`/mcp`) from the CLI's `EQUIPMENT_REGISTER_URL` (`/rpc/v1`) and covers unique editable tags, stable UUIDs, and list bounds. Read the [SDK client](../examples/equipment-register/client.ts) or [MCP contract](/reference/runtime#mcp-tools) to integrate your own client.

## Check current entitlements

### Purchased guides

Use this when an authorized user also needs a current grant for one specific resource. The application checks a persisted guide purchase after tenant and role checks. A missing purchase produces `EntitlementRequired`; a grant does not bypass row visibility.

The [purchased-guides guide](../examples/purchased-guides/README.md) contrasts an unlocked guide, a locked guide, and a guide in another tenant. It also explains why a list containing a locked visible guide fails rather than silently returning a shorter page. There is no payment-provider or checkout integration.

## Durable work

These examples use native Effect durable execution, composed through application-provided layers. Each has an application database and a separate execution database. Run either `serve` or `worker` against one execution store, **not both at once**.

### Report exports

Use this for work that waits for approval and then publishes a file. The workflow takes supplied financial lines, enforces account subscription access on generation, waits for an operator when requested, and writes a JSON report artifact.

The [report-exports guide](../examples/report-exports/README.md) supplies isolated storage paths, demo credentials, generation payload, release commands, and polling instructions. Acceptance of an execution is not completion; wait for `Succeeded` and inspect the returned artifact path. It does not query a separate accounting system or provide a payment integration.

### Appointment reminders

Use this for durable scheduling and deduplicated application-side delivery. The example schedules an appointment reminder and later inserts a notification into an application inbox. It does not send email or SMS.

The [appointment-reminders guide](../examples/appointment-reminders/README.md) creates future timestamps, submits a reminder, reads the delivered inbox row, and explains its projection and retention. It also shows how to stop the server and continue accepted work in worker mode.

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
