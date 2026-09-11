# Expense ledger

[All examples](../README.md)

Record a small multi-currency expense period, then retrieve, correct, and delete one entry. This guide keeps money in integer minor units and lets you see why totals are grouped by both category and currency rather than added across currencies.

## Before you start

Use Bun from the repository root. The expense database is local SQLite and the application is public on loopback: no token is needed. The server, CLI, browser UI, generated admin, and MCP endpoint are separate surfaces over the same application.

Install dependencies and build the precompiled browser assets once:

```bash
bun install
bun run build
```

`bun run build` is required before `serve`: the Foldkit page at `/` needs its prebuilt `web/dist` JavaScript and CSS, and this application also enables the generated admin at `/admin`.

For a disposable tutorial database, choose a new path before starting the server. Do not reuse this path if you want the fixed examples below to begin empty.

```bash
export EXPENSE_LEDGER_DB="$(mktemp -d)/expense-ledger.sqlite"
bun run expense-ledger:server
```

Leave that terminal running. It listens on `http://127.0.0.1:3000`, serves RPC at `http://127.0.0.1:3000/rpc/v1`, MCP at `http://127.0.0.1:3000/mcp`, the Foldkit ledger at `/`, and the generated admin at `/admin`.

Open a second terminal at the repository root for the CLI. Alternatively, if another example uses port 3000, use the following **instead of** the server command above (stop an already-running instance first), then set the client URL separately:

```bash
PORT=3001 bun run expense-ledger:server
# In the separate CLI terminal:
export EXPENSE_LEDGER_URL=http://127.0.0.1:3001/rpc/v1
```

`EXPENSE_LEDGER_DB` otherwise defaults to `data/expense-ledger.sqlite`; `EXPENSE_LEDGER_URL` otherwise defaults to the port-3000 RPC URL. A server restart with the same database retains rows and checks the ordered, frozen migration history rather than resetting the ledger.

## Run it

### 1. Record two currencies on the bounds of a period

In the CLI terminal, create two meal expenses. `amountMinor` is an integer count of the currency's minor units: `1875` means 18.75 only for a currency with two minor decimal places; the application does not format or convert it.

```bash
bun run expense-ledger expenses.record --input-json '{"date":"2026-09-01","merchant":"Railway Cafe","category":"meals","amountMinor":1875,"currency":"USD"}'
bun run expense-ledger expenses.record --input-json '{"date":"2026-09-02","merchant":"Station Bistro","category":"meals","amountMinor":1600,"currency":"EUR"}'
```

Each success is a complete expense row with a generated UUIDv7 `id`. Copy the `id` from the first result into the assignment below, replacing the placeholder—not the surrounding quotes:

```bash
export EXPENSE_ID='paste-the-first-returned-id-here'
```

The accepted categories are `meals`, `travel`, `software`, `supplies`, and `other`. A date is a Gregorian `YYYY-MM-DD` string; a currency is exactly three uppercase letters.

### 2. Query the inclusive period and calculate totals

Ask for exactly the two-day period, filtered to meals:

```bash
bun run expense-ledger expenses.query --input-json '{"from":"2026-09-01","through":"2026-09-02","category":"meals","limit":10}'
bun run expense-ledger expenses.totals --input-json '{"from":"2026-09-01","through":"2026-09-02","category":"meals"}'
```

The query returns an array ordered first by `date`, then by `id`. Notice that both endpoint dates are included: the condition is `date >= from` and `date <= through`. The total call returns separate rows such as:

```json
[
  { "category": "meals", "currency": "EUR", "totalMinor": 1600 },
  { "category": "meals", "currency": "USD", "totalMinor": 1875 }
]
```

There is deliberately no cross-currency grand total. Totals group by both `category` and `currency`, and they include every matching expense even when a query's limit truncates its rows.

`expenses.query` is an authored bounded array, not a generated cursor page: omitting `limit` uses 50, its maximum is 100, and it returns no `nextCursor`. `expenses.totals` accepts the same date/category filter but ignores `limit` for aggregation.

### 3. Read, correct, and remove the first entry

The update payload is the whole row: retain the UUID and send every editable value. Here we correct the amount, then remove the row and demonstrate the typed missing-record failure.

```bash
bun run expense-ledger expenses.get --input-json "{\"id\":\"$EXPENSE_ID\"}"
bun run expense-ledger expenses.update --input-json "{\"id\":\"$EXPENSE_ID\",\"date\":\"2026-09-01\",\"merchant\":\"Railway Cafe\",\"category\":\"meals\",\"amountMinor\":1975,\"currency\":\"USD\"}"
bun run expense-ledger expenses.remove --input-json "{\"id\":\"$EXPENSE_ID\"}"
bun run expense-ledger expenses.get --input-json "{\"id\":\"$EXPENSE_ID\"}"
```

The first three calls return the selected row (the remove call returns the deleted row). The final call exits nonzero with the declared `ExpenseNotFound` failure and its `id`. The EUR record remains; rerunning totals for the period after removal returns only its EUR 1600 row.

## Boundaries to notice

- Amounts must be positive safe integers from 1 through `9007199254740991`. Negative, zero, fractional, or unsafe values fail input validation; this is minor-unit arithmetic, not floating-point currency arithmetic.
- A query with `from` later than `through` fails with `InvalidExpenseDateRange` and echoes the two dates:

  ```bash
  bun run expense-ledger expenses.query --input-json '{"from":"2026-09-03","through":"2026-09-02"}'
  ```

- Storage and result-codec failures are translated to `ExpenseLedgerUnavailable`. That includes a database failure and a total that cannot satisfy the declared safe-integer result schema; no silently rounded or unrepresentable total is returned.
- A missing row from `get`, `update`, or `remove` is `ExpenseNotFound`. Invalid dates, categories, currencies, UUIDs, and query limits are rejected by their request schemas before the handler can perform the operation.
- The Foldkit page at `/` has date/category controls, a bounded expense table, a totals-by-category-and-currency table, and record/edit/remove controls. `/admin` is the separate generated RPC admin. Neither surface is an accounting workflow.

This is a local expense register. It does not implement double-entry accounting, exchange rates, reimbursement review, taxes, production identity, or a payment-provider workflow.

## Read next

- [Expense schemas and declared failures](domain.ts)
- [RPC contracts](contracts.ts) and [authored SQLite handlers](sqlite.ts)
- [Resource registration](resources.ts), [migration history](migrations.ts), and [runtime entry point](main.ts)
- [Foldkit ledger UI](web/main.ts)
- [Resource/list and implicit identifier contract](../../docs/reference/resources.md)
- [Bun runtime, RPC, MCP, and environment settings](../../packages/effect-domains/src/application-bun.ts)
- [Runtime reference](../../docs/reference/runtime.md)
