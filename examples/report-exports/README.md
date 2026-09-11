# Report exports

[All examples](../README.md)

Generate a durable financial-report JSON file from lines supplied with the request, then have an operator release and inspect it. The outcome is a file named for its execution ID, containing the request's report, lines, release record, and separate debit and credit totals in minor units. This is not an accounting-system integration: the supplied lines are the report's source data, and the application does not check that the two totals balance.

## Before you start

Use Bun 1.4.0 from the repository root. The server serves the Foldkit application at `/`, so build its assets before starting `serve`; rebuild after frontend changes. There is no generated `/admin` application for this example; every `serve` command does expose the protected MCP endpoint at `/mcp` and the RPC endpoint at `/rpc/v1`.

The walkthrough uses disposable application and execution databases so that its account-bound report ID cannot collide with a previous run.

```bash
bun install
bun run build

RUN_ID=$(bun -e 'console.log(Bun.randomUUIDv7())')
mkdir -p "$PWD/.tmp"
export REPORT_EXPORTS_DB="$PWD/.tmp/report-exports-$RUN_ID.sqlite"
export REPORT_EXPORTS_EXECUTION_DB="$PWD/.tmp/report-exports-execution-$RUN_ID.sqlite"
export REPORT_EXPORTS_OUTPUT_DIR="$PWD/.tmp/report-artifacts-$RUN_ID"
export REPORT_EXPORTS_IDENTITY_DB="$PWD/.tmp/report-exports-identity-$RUN_ID.sqlite"
export EFFECT_DOMAINS_DEMO_PASSWORD='choose-a-local-bootstrap-password'
```

The identity database must remain distinct from both report stores. Start the server in one terminal. `PORT` changes only the listener, so the client URL is set separately below.

```bash
PORT=3001 bun run report-exports:server
```

In a second terminal, point the CLI at that server and issue Alice's generation credential and the administrator's operator credential. The initial Acme subscription is seeded once with a 30-day active term, so this fresh database permits Alice to generate.

```bash
export REPORT_EXPORTS_URL=http://127.0.0.1:3001/rpc/v1
export DEMO_PASSWORD='choose-a-local-bootstrap-password' # same value used by the server
issue_report_token() {
  bun run report-exports identity.login --input-json "$(
    bun -e 'const [username, password] = process.argv.slice(2); if (!password) throw new Error("DEMO_PASSWORD is required"); console.log(JSON.stringify({ username, password }))' "$1" "$DEMO_PASSWORD"
  )" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).token)'
}
export REPORT_EXPORTS_TOKEN="$(issue_report_token alice)"
export ADMIN_TOKEN="$(issue_report_token admin)"
export REPORT_ID="september-ledger-$(bun -e 'console.log(Bun.randomUUIDv7())')"
```

The native login result is a secret per-call bearer token. `identity.current` confirms its verified subject and expiry; `identity.logout` revokes the current `REPORT_EXPORTS_TOKEN`. Accounts bootstrap only once and sessions expire; see [example identity](../README.md#example-identity).

## Run it

### Generate an approval-gated export

Submit the report with `ReportExport.GenerateDiscard`. Its successful value is the stable execution ID as a JSON string. Copy that string without its JSON quotes into `EXECUTION_ID` after the command finishes; it is the value the operator needs.

```bash
bun run report-exports ReportExport.GenerateDiscard --input-json "{\"report\":{\"reportId\":\"$REPORT_ID\",\"reportingPeriod\":{\"startsAt\":\"2026-09-01T00:00:00.000Z\",\"endsAt\":\"2026-10-01T00:00:00.000Z\"},\"currency\":\"USD\",\"releasePolicy\":\"operatorApproval\"},\"lines\":[{\"accountCode\":\"4000\",\"description\":\"September consulting revenue\",\"direction\":\"credit\",\"amountMinor\":125000},{\"accountCode\":\"6100\",\"description\":\"September office supplies\",\"direction\":\"debit\",\"amountMinor\":8500}]}"

# Replace the example with the JSON string returned above, without its quotes.
export EXECUTION_ID='returned-execution-id'
```

`GenerateDiscard` means **accepted**, not completed. The workflow waits five seconds before rendering; with `operatorApproval`, it then waits for an explicit release. A first poll can therefore return:

```json
{ "_tag": "PendingOrUnknown" }
```

That tag deliberately covers both a still-suspended export and an execution ID this runner does not know. It is not a confirmation that the artifact exists.

### Poll and release as the operator

Switch to the global administrator, then poll, release, and poll again. `Release` and `GenerateResume` have void success values; the useful completion record comes from `Poll`.

```bash
export REPORT_EXPORTS_TOKEN="$ADMIN_TOKEN"

bun run report-exports ReportExport.Poll --input-json "{\"executionId\":\"$EXECUTION_ID\"}"
bun run report-exports ReportExport.Release --input-json "{\"executionId\":\"$EXECUTION_ID\"}"
bun run report-exports ReportExport.Poll --input-json "{\"executionId\":\"$EXECUTION_ID\"}"
bun run report-exports ReportExport.Status
```

Keep polling until the result has `_tag: "Succeeded"`. Its complete result shape is:

```json
{
  "_tag": "Succeeded",
  "artifactPath": "/absolute/output/directory/execution-id.json",
  "reportId": "...",
  "reportingPeriod": { "startsAt": "...", "endsAt": "..." },
  "currency": "USD",
  "releasePolicy": "operatorApproval",
  "releasedBy": "admin",
  "lineCount": 2,
  "totalDebitMinor": 8500,
  "totalCreditMinor": 125000
}
```

Open the returned `artifactPath`. Its JSON has `report`, `release`, `lines`, and `totals` keys. For this request the `release` value records `policy: "operatorApproval"` and `releasedBy: "admin"`; `totals` keeps debit and credit separate. Artifact writing creates `<REPORT_EXPORTS_OUTPUT_DIR>/<executionId>.json` with an atomic replacement. A failed workflow instead returns `{ "_tag": "Failed", "reason": "..." }` from `Poll`.

`ReportExport.Status` is an operator diagnostic snapshot with `activeEntities`, `shuttingDown`, and `runners`. Each runner has `host`, `port`, `healthy`, `groups`, and `weight`; it does not report artifact completion.

### Compare the automatic path

For an export that does not need operator approval, use a **new** report ID and set `releasePolicy` to `automatic` in the same request. It still observes the five-second durable delay, but it bypasses the release barrier; poll it as admin until it succeeds. An automatic artifact has `releasedBy: null`.

`ReportExport.Generate` takes the identical request but waits for completion, which is useful for the automatic path. It returns the report result directly (`artifactPath`, totals, and the other result fields), without `Poll`'s `_tag` wrapper. Do not use it alone for an approval-gated report: it remains waiting until an operator releases that execution from another client. `ReportExport.GenerateResume` accepts `{ "executionId": "..." }` and lets an admin resume that existing execution; it does not create a replacement report or make an unknown execution valid.

## Identity, access, and safe retries

The caller never sends an account ID. Generation derives it from the authenticated subject's tenant, and the durable execution key is the pair of that account and `report.reportId`. Consequently:

- Repeating the same report ID for the same account addresses the same execution. It is not an update or a replacement for changed lines. Use a fresh report ID for different source data.
- Alice's issued Acme editor credential can generate in the newly seeded database. An issued Bob credential is a reader and fails the editor policy. An issued `outsider` credential is an editor in the `other` account but has no seeded paid subscription, so generation fails its `reports.generate` entitlement. The issued Admin credential is the global operator for polling, release, resume, status, and `GET /operator/metrics`; operator access does not require a subscription.
- The subscription resolver checks the stored row and clock on each generation request. Cancellation retains access until `validUntil`; a canceled row can use a non-null `graceUntil` until that exclusive timestamp. Restarting never renews, restores, or seeds over an existing subscription.
- Once a workflow has been accepted, its durable steps do not re-check the generation entitlement. That lets already accepted work continue after the subscription changes; it does not authorize a new generation.

The request is deliberately constrained: report IDs start alphanumeric and may then contain letters, numbers, `.`, `_`, or `-` (up to 128 characters); account codes are 4–10 digits; currencies are `AUD`, `CAD`, `EUR`, `GBP`, `JPY`, or `USD`; every line has a nonempty description, `debit` or `credit` direction, and a positive safe-integer `amountMinor`. The reporting period must end after it starts. Schema failures exit nonzero, while arithmetic that cannot be represented safely fails the workflow. There is no external ledger lookup, provider, webhook, checkout, or credit-consumption simulation.

## Web, MCP, and operations

At `http://127.0.0.1:3001/`, the Foldkit page starts signed out and provides the shared login form. It uses canonical native clients and retains issued bearer tokens only in memory. An editor can submit a generated request; an administrator can enter an execution ID to poll, release, or inspect runner status. Session changes clear drafts and prior execution state, and field errors are shown for invalid form values. The page has no generated admin area. The same published operations are available as protected MCP tools at `http://127.0.0.1:3001/mcp`; provide the bearer token on every tool call and wrap a request as `{ "input": <RPC payload> }`. A successful MCP tool result is `structuredContent.result`; declared errors have `isError: true`.

The durable engine uses one native `SingleRunner` for an execution store. Run **either** `report-exports:server` **or** `report-exports:worker` with a given `REPORT_EXPORTS_EXECUTION_DB`, never both concurrently. Worker mode hosts the same execution/background layers without HTTP; stop the server and run this in the same terminal, retaining all three path variables:

```bash
bun run report-exports:worker
```

Interruption caveat (2026-09-11): stopping immediately after an automatic `GenerateDiscard` acknowledgement produced a persisted `Failed` result with `EntityNotAssignedToRunner` in the documentation smoke. Starting the worker did not publish that artifact, and an explicit `GenerateResume` followed by `Poll` still reported failure. Do not assume every accepted execution will recover across arbitrary stop points; inspect `Poll` and its `reason`, and require `Succeeded` plus the artifact before treating an export as complete. See the [verification record](../../docs/wiki/validation-strategy.md#2026-09-11-standalone-example-guides).

Return to `report-exports:server` with those paths to poll or release remotely. The application database defaults to `data/report-exports.sqlite`; execution storage defaults to `data/report-exports-execution.sqlite`; `REPORT_EXPORTS_OUTPUT_DIR` is required. Back up the application and execution databases together, but recognize their transaction boundaries are separate. There is no cross-database transaction, automatic outbox, or exactly-once claim for arbitrary external services. The queue makes the artifact's execution-ID file durable and writes it via atomic rename; it does not turn a broader multi-system workflow into exactly-once delivery.

`EFFECT_DOMAINS_DEMO_PASSWORD` is required at every server start and `REPORT_EXPORTS_IDENTITY_DB` defaults to `data/report-exports-identity.sqlite`; configure it separately from `REPORT_EXPORTS_DB` and `REPORT_EXPORTS_EXECUTION_DB`.

For source details, see the [workflow and RPCs](workflow.ts), [contracts](contracts.ts), [authorization](authorization.ts), [subscription resolver](subscriptions.ts), [runtime layer](runtime.ts), [artifact writer](writer.ts), and the shared [runtime reference](../../docs/reference/runtime.md#durable-execution).