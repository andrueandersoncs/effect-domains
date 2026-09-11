# Orders and invoices

Build a tenant-scoped sales order, add a priced line, issue its one invoice, and record a local payment transition. This is a runnable billing workflow with authored mutations; it is not a payment-provider integration.

[All examples](../README.md)

## Run it

Run these commands from the repository root. The server and its generated frontend require the prebuilt Foldkit assets, so build before starting it. Use the timestamped database name below as disposable walkthrough state; do not point it at data you intend to keep.

**Server terminal**

```bash
bun install
bun run build
export ORDERS_INVOICES_DB="$PWD/orders-invoices-walkthrough-$(date +%s).sqlite"
export ORDERS_INVOICES_IDENTITY_DB="$PWD/orders-invoices-identity-$(date +%s).sqlite"
export EFFECT_DOMAINS_DEMO_PASSWORD='choose-a-local-bootstrap-password'
PORT=3001 bun run orders-invoices:server
```

The identity database must be distinct from `ORDERS_INVOICES_DB`. `EFFECT_DOMAINS_DEMO_PASSWORD` is required on each startup, but account bootstrap inserts only once and does not reset account changes. The server is loopback-only at `http://127.0.0.1:3001`. It exposes Effect JSON RPC at `/rpc/v1`, Streamable HTTP MCP at `/mcp`, the application page at `/`, and generated admin at `/admin`.

**Client terminal**

```bash
export ORDERS_INVOICES_URL=http://127.0.0.1:3001/rpc/v1
export DEMO_PASSWORD='choose-a-local-bootstrap-password' # same value used by the server
issue_billing_token() {
  bun run orders-invoices identity.login --input-json "$(
    bun -e 'const [username, password] = process.argv.slice(2); if (!password) throw new Error("DEMO_PASSWORD is required"); console.log(JSON.stringify({ username, password }))' "$1" "$DEMO_PASSWORD"
  )" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).token)'
}
export ORDERS_INVOICES_TOKEN="$(issue_billing_token alice)"
export BOB_TOKEN="$(issue_billing_token bob)"
export OUTSIDER_TOKEN="$(issue_billing_token outsider)"
```

Tokens are secret bearer credentials for every protected call, not request data. `identity.current` reports their verified subject and expiry; `identity.logout` revokes the current `ORDERS_INVOICES_TOKEN`. Sessions expire and accounts bootstrap only once as described in [example identity](../README.md#example-identity).

Create an order. The input has exactly `number` and `customer`; its response is the complete order row. Copy the returned `id` into the quoted assignment before continuing.

```bash
bun run orders-invoices billing.createOrder --input-json '{"number":"SO-WALKTHROUGH-1","customer":"Example customer"}'
# Set ORDER_ID to the id in that response, for example:
export ORDER_ID='replace-with-returned-order-id'
```

The new row has server-derived `tenantId: "acme"`, `status: "draft"`, `totalMinor: 0`, and `version: 1`. It also has a generated UUIDv7 `id`; `tenantId`, status, total, version, and id are not create inputs.

Add one line with the current order version. This command returns an **order summary**: `{ "order": …, "lines": […], "invoice": null }`, rather than only the inserted line.

```bash
bun run orders-invoices billing.addLine --input-json "{\"orderId\":\"$ORDER_ID\",\"expectedVersion\":1,\"lineNumber\":1,\"description\":\"Consulting\",\"quantity\":2,\"unitAmountMinor\":1250}"
```

Notice that the returned `order.totalMinor` is `2500` and `order.version` is `2`; `lines[0]` has `lineNumber`, `description`, `quantity`, and `unitAmountMinor`. Amounts are integer minor units, so this is 25.00 only if the caller's business convention treats the units as cents.

Issue the order's single invoice using version 2. The result is the complete invoice row; set `INVOICE_ID` to its returned `id`.

```bash
bun run orders-invoices billing.issueInvoice --input-json "{\"orderId\":\"$ORDER_ID\",\"expectedVersion\":2,\"number\":\"INV-WALKTHROUGH-1\"}"
export INVOICE_ID='replace-with-returned-invoice-id'
```

The invoice starts with `status: "issued"`, `totalMinor: 2500`, and `version: 1`; issuing it changes the order to `status: "invoiced"` and version 3 in the same transaction. Record its payment, then retrieve the joined summary.

```bash
bun run orders-invoices billing.payInvoice --input-json "{\"invoiceId\":\"$INVOICE_ID\",\"expectedVersion\":1}"
bun run orders-invoices billing.getOrder --input-json "{\"orderId\":\"$ORDER_ID\"}"
```

Payment returns the invoice at `status: "paid"` and `version: 2`. `billing.getOrder` returns the order, lines ordered by `lineNumber`, and that invoice. It is the authored summary read; use the generated `orders.get`, `order_lines.get`, `invoices.get`, or their lists when a single resource row/page is what you need.

## Observe the boundaries

Try these only after the successful flow above. Each command exits nonzero with the encoded named error.

```bash
# The line command still claims version 1, but the order is already version 3.
bun run orders-invoices billing.addLine --input-json "{\"orderId\":\"$ORDER_ID\",\"expectedVersion\":1,\"lineNumber\":2,\"description\":\"Stale line\",\"quantity\":1,\"unitAmountMinor\":100}"

# Version 3 is current, but invoiced orders cannot receive lines.
bun run orders-invoices billing.addLine --input-json "{\"orderId\":\"$ORDER_ID\",\"expectedVersion\":3,\"lineNumber\":2,\"description\":\"Late line\",\"quantity\":1,\"unitAmountMinor\":100}"

# The paid invoice is version 2; payment is only valid from issued.
bun run orders-invoices billing.payInvoice --input-json "{\"invoiceId\":\"$INVOICE_ID\",\"expectedVersion\":2}"
```

The first request reports `VersionConflict` for the order. The second reports `OrderNotDraft`; the third reports framework `InvalidInvoiceTransition` with action `pay` and actual state `paid`. Do not retry a stale mutation blindly: fetch the current summary, choose a new action, and submit its current version.

Mutations require an `editor` or `admin` subject. For example, the issued Bob session is an Acme `reader`, so this request reports `Forbidden`:

```bash
ORDERS_INVOICES_TOKEN="$BOB_TOKEN" bun run orders-invoices billing.createOrder --input-json '{"number":"SO-READER-1","customer":"Blocked reader"}'
```

Rows are tenant-scoped before generated reads and before authored summary lookups. The issued `outsider` session is user `alice` in tenant `other`: it may create an order in its own tenant, and may reuse `SO-WALKTHROUGH-1` there, but it cannot read Acme's `ORDER_ID`. Its `billing.getOrder` reports `OrderNotFound`; `orders.get` hides the same row as `ResourceNotFound`.

```bash
ORDERS_INVOICES_TOKEN="$OUTSIDER_TOKEN" bun run orders-invoices billing.getOrder --input-json "{\"orderId\":\"$ORDER_ID\"}"
ORDERS_INVOICES_TOKEN="$OUTSIDER_TOKEN" bun run orders-invoices orders.get --input-json "{\"id\":\"$ORDER_ID\"}"
```

## Data and operation limits

All three generated resources are read-only at the RPC boundary:

| Resource | Published operations | Page limit / filters |
| --- | --- | --- |
| `orders` | `orders.get`, `orders.list` | 100; `number`, `status` |
| `order_lines` | `order_lines.get`, `order_lines.list` | 100; `orderId` |
| `invoices` | `invoices.get`, `invoices.list` | 100; `orderId`, `number`, `status` |

A generated list returns `{ "items": [...], "nextCursor": string | null }`, ordered by identifier. Its declared limit is both the default and the maximum; return a non-null cursor unchanged with the same filter to request another page. No generated create, update, patch, or remove operation can bypass the authored lifecycle.

The mutations use server-derived tenant identity and database transactions. Orders have tenant-local unique order numbers; invoices have tenant-local unique invoice numbers and one invoice per `(tenantId, orderId)`. Lines are unique per `(tenantId, orderId, lineNumber)`. Composite `(tenantId, orderId)` foreign keys from lines and invoices to orders prevent a privileged SQL writer from attaching a row across tenants. Tenant/status indexes support the declared resource shapes; they do not replace authorization.

`quantity`, `lineNumber`, versions, and unit amounts must be positive safe integers. `totalMinor` is non-negative and checked for safe-integer multiplication and addition. An empty draft cannot be issued (`InvoiceRequiresLines`); duplicate numbers report `DuplicateOrderNumber` or `DuplicateInvoiceNumber`; unsafe arithmetic reports `TotalOverflow`. A payment only changes this local invoice state—there is no provider call, tax/currency calculation, credit note, checkout, request-idempotency key, or production identity system.

## Browser, admin, and MCP

At `http://127.0.0.1:3001/`, the Foldkit page starts signed out and provides the shared login form. It uses the canonical native RPC client, holds the issued credential only in memory, and clears draft/loaded order state on login, logout, or expiry. An editor can create, add a line, issue, reload, and record payment; field-specific form errors include invalid numeric inputs, while a version conflict prompts a reload. Roles are enforced by the server, not a client-side role switch.

`http://127.0.0.1:3001/admin` is available because this application enables generated admin. Build assets first, paste a real issued bearer credential, and expect its generated reads to use the same tenant policy and cursor navigation. MCP is available at `http://127.0.0.1:3001/mcp`; each published RPC is a tool with arguments `{ "input": <operation JSON> }`. Protected calls still require a bearer credential for every request. The CLI and MCP are RPC interfaces, not REST endpoints.

## Storage and source map

| Setting | Default | Use |
| --- | --- | --- |
| `ORDERS_INVOICES_DB` | `data/orders-invoices.sqlite` | Server SQLite database |
| `PORT` | `3000` | Loopback server port |
| `ORDERS_INVOICES_URL` | `http://127.0.0.1:3000/rpc/v1` | CLI RPC endpoint |
| `ORDERS_INVOICES_TOKEN` | unset | CLI bearer token |
| `ORDERS_INVOICES_IDENTITY_DB` | `data/orders-invoices-identity.sqlite` | Server identity database; must differ from billing data |
| `EFFECT_DOMAINS_DEMO_PASSWORD` | required | Bootstrap password for seeded example accounts |

Startup decodes and applies the frozen [migration history](migrations.ts); it preserves data and rejects an untracked or drifted database rather than resetting/adopting it. Use a fresh database path when repeating this walkthrough. The checked-in [initial artifact](migrations/001_initial.json) records the indexes, uniqueness, and composite foreign keys.

- [`domain.ts`](domain.ts): canonical rows, inputs, checked minor-unit/version fields, states, and named errors.
- [`resources.ts`](resources.ts): tenant-scoped generated reads and relational declarations.
- [`contracts.ts`](contracts.ts): the authored nested order-summary success schema.
- [`sqlite.ts`](sqlite.ts): declarative billing operations, repository writes, transaction boundaries, and the aggregate SQL read model built with `Table.project`.
- [`main.ts`](main.ts): identity service, generated admin, frontend route, migrations, and runner.
- [`web/main.ts`](web/main.ts): the actual browser workflow and its native client reader controls.
- [Resource reference](../../docs/reference/resources.md): generated list/page and entitlement-independent resource contracts.
- [Runtime reference](../../docs/reference/runtime.md): loopback runtime, CLI, RPC, and migration behavior.
