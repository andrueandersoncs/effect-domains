---
description: Choose a runnable application for CRUD, authorization, migrations, authored business rules, or durable work.
---

# Choose an example

Each of the thirteen applications has its own detailed guide beside its source. Choose a domain below, then follow its setup, CLI workflow, expected failures, and storage/authentication notes. Shared conventions live in the [example index](../examples/README.md).

Run commands from the repository root after `bun install`. Run `bun run build` before serving **any** example: the shared Application UI is prebuilt once and interpreted from each application's compiled contracts. Keep demonstration servers on loopback. Protected applications accept issued credentials through `identity.login`; the example identity store is not a production authentication service.

Reading List is the smallest full-stack observability walkthrough. Report Exports adds worker spans, logs, runtime/custom metrics, and durable operator audit records; Support Cases adds nested-application HTTP/RPC telemetry and durable case-lifecycle audit history. See the [runtime observability contract](reference/runtime.md#opentelemetry).

## Start with records

| Application guide | What to look for | Related framework guide |
| --- | --- | --- |
| [Reading list](../examples/reading-list/README.md) | Generated filtered CRUD forms, nullable fields, and cursor lists | [First-run tutorial](/getting-started) |
| [Team tasks](../examples/team-tasks/README.md) | Tenant scope, reusable subject policies, and trusted identity fields | [Authorization guide](/guides/authorization) |
| [Editorial calendar](../examples/editorial-calendar/README.md) | Generated CRUD forms and historical migration | [Migration guide](/guides/migrations) |
| [Field notes](../examples/field-notes/README.md) | Protected operations, encrypted report text, and SQL EventLog replica synchronization | [Authorization guide](/guides/authorization) |

For any example, `bun run <application> --help` lists its commands and `bun run <application> inspect` describes its contracts without starting the server.

## Go beyond generated CRUD

### Expense ledger

Use this when an operation is a query or calculation, not just a record list. The application records integer minor-unit amounts and calculates category totals separately for each currency. Its date-range query has its own ordering and bounds.

Follow the [expense-ledger guide](../examples/expense-ledger/README.md) to record two currencies, query inclusive date bounds, compare totals, and correct or remove an entry. Read [`sqlite.ts`](../examples/expense-ledger/sqlite.ts) beside its schemas to see `Command.define`/`Command.implement` and authored SQL working with generated repositories.

### Repair workshop

Use this for a board that joins repairs to current customer and optional technician records. The [repair-workshop guide](../examples/repair-workshop/README.md) creates assigned and unassigned jobs, changes joined names and on-call values, contrasts bounded arrays with cursor pages, and exercises foreign-key failures.

[`board.ts`](../examples/repair-workshop/board.ts) declares the projection, joins, filtering, ordering, bounds, and cursor page with `ReadModel`; [`sqlite.ts`](../examples/repair-workshop/sqlite.ts) publishes it through `ReadModel.publish` without restating the fragment.

### Support cases

Use this when sibling domain modules share relations and operation dependencies: the directory child owns customers and agents, while the case-management child owns cases, events, the joined board, and transactional lifecycle commands. `Application.compile` validates their cross-child references after flattening both modules. The [support-cases guide](../examples/support-cases/README.md) covers open, triage, assignment, resolution, stale writes, duty checks, joined board filters, and nested history.

[`application.ts`](../examples/support-cases/application.ts) shows the sibling `Part.application` boundaries. [`board.ts`](../examples/support-cases/board.ts) is the second bounded `ReadModel` domain. [`sqlite.ts`](../examples/support-cases/sqlite.ts) keeps the one-to-many event projection and transactional business commands authored rather than extending the read-model language into an aggregate query DSL.

### Reservations

Use this when a transition changes one record while inventory accounting still preserves a cross-record invariant. The resource declares its status graph with `Transitions.make`; the authored transactional operations reserve stock and run the accounting.

The [reservation walkthrough](../examples/reservations/README.md) covers stock reads, valid and invalid transitions, and persistence. Compare the [resource](../examples/reservations/resources.ts) with the [operations](../examples/reservations/sqlite.ts).

### Orders and invoices

Use this for nested application composition, tenant-scoped relations, uniqueness constraints, optimistic versions, declared transitions, and multi-record transactions. The application nests the three resources and their authored command bundle as one billing domain, then composes that module with native identity before final compilation.

Follow the [orders-and-invoices guide](../examples/orders-invoices/README.md) for the complete order/line/invoice/payment sequence, expected versions, and role/tenant failures. [`application.ts`](../examples/orders-invoices/application.ts) shows the `Part.application` boundary; [`resources.ts`](../examples/orders-invoices/resources.ts) contains scoped relations and transition declarations; [`sqlite.ts`](../examples/orders-invoices/sqlite.ts) uses `Table.project` and `Command.bundle`.

## Connect an MCP client

### Equipment register

This public example exposes equipment records as generated MCP tools. Its [equipment-register guide](../examples/equipment-register/README.md) runs the official SDK client through discovery, creation, relocation, retirement, and removal, then repeats the lifecycle through the CLI.

The generated Application UI at `/` exposes the same resource operations; `bun run build` prepares its shared assets. The guide distinguishes `EQUIPMENT_REGISTER_MCP_URL` (`/mcp`) from the CLI's `EQUIPMENT_REGISTER_URL` (`/rpc/v1`) and covers unique editable tags, stable UUIDs, and list bounds. Read the [SDK client](../examples/equipment-register/client.ts) or [MCP contract](/reference/runtime#mcp-tools) to integrate your own client.

## Check current entitlements

### Purchased guides

Use this when an authorized user also needs a current grant for one specific resource. The application checks a persisted guide purchase after tenant and role checks. A missing purchase produces `EntitlementRequired`; a grant does not bypass row visibility.

The [purchased-guides guide](../examples/purchased-guides/README.md) contrasts an unlocked guide, a locked guide, and a guide in another tenant. It also explains why a list containing a locked visible guide fails rather than silently returning a shorter page. There is no payment-provider or checkout integration.

## Durable work

These examples use native Effect durable execution, composed through application-provided layers. Each has an application database and a separate execution database. The default is local `single` mode; `runner` plus `client` modes support colocated processes sharing one execution SQLite file. This is not cross-host SQLite distribution.

### Report exports

Use this for work that waits for approval and then publishes a file. The workflow takes supplied financial lines, enforces account subscription access on generation, waits for an operator when requested, and writes a JSON report artifact.

The [report-exports guide](../examples/report-exports/README.md) supplies isolated storage paths, demo credentials, generation, cancellation, release, recovery, reconciliation, durable audit inspection, polling, multi-runner instructions, and full OTLP observability for the worker lifetime. Acceptance writes an application outbox row; it is not completion. Wait for `Succeeded` and inspect the returned artifact path. The immutable file sink is idempotent, but the application does not query a separate accounting system or provide a payment integration.

### Appointment reminders

Use this for durable scheduling and deduplicated application-side delivery. The example schedules an appointment reminder and later inserts a notification into an application inbox. It does not send email or SMS.

The [appointment-reminders guide](../examples/appointment-reminders/README.md) creates future timestamps, submits a reminder, reads the delivered inbox row, and explains its projection, retention, and colocated runner modes.

Application and execution transactions are separate. Report outbox dispatch is at-least-once with deterministic native IDs, not one atomic cross-database commit. The demonstrated immutable artifact reconciliation does not establish exactly-once behavior for arbitrary external services.

## Navigate the source

Most examples use this layout:

| File | Read it to understand |
| --- | --- |
| `domain.ts` | Canonical values, shared domain schemas, and domain errors |
| `resources.ts` | Persistence, authorization, generated operations, versions, and transitions |
| `sqlite.ts` | `Command` specifications, implementations, and authored SQL where needed |
| `application.ts` | `Application.define` parts and the compiled `ApplicationIR` |
| `migrations.ts` | Ordered `SqliteMigrations.history(...)` imports of frozen artifacts |
| `main.ts` | `ApplicationBun.run` runtime service wiring and admin opt-in |

For shared command options, see [runtime and clients](/reference/runtime). For dated verification and its limits, see the [validation record](/wiki/validation-strategy).
