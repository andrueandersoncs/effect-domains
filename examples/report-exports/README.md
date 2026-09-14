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

`GenerateDiscard` means **durably accepted**, not completed. Acceptance and dispatch are separate: the application transaction inserts an `accepted` outbox row, and a scoped relay retries native workflow dispatch with the deterministic execution ID. The workflow waits five seconds before rendering; with `operatorApproval`, it then waits for an explicit release. Polling distinguishes the application and engine states:

- `{ "_tag": "Pending", "stage": "accepted" | "dispatched" | "writing" }`
- `{ "_tag": "Recoverable", "reason": "..." }` for a suspended infrastructure failure
- `{ "_tag": "Cancelled" }`
- `{ "_tag": "Failed", "reason": "..." }`
- `{ "_tag": "Unknown" }` only when the application execution row does not exist
- `{ "_tag": "Succeeded", ... }` only after the durable artifact result is recorded

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

Open the returned `artifactPath`. Its JSON has `report`, `release`, `lines`, and `totals` keys. For this request the `release` value records `policy: "operatorApproval"` and `releasedBy: "admin"`; `totals` keeps debit and credit separate. Artifact writing creates `<REPORT_EXPORTS_OUTPUT_DIR>/<executionId>.json` atomically. Repeating the same content returns the existing artifact; different content for that immutable execution path fails with `ReportArtifactConflict` instead of overwriting it.

`ReportExport.Status` is an operator diagnostic snapshot with `activeEntities`, `shuttingDown`, and `runners`. Each runner has `host`, `port`, `healthy`, `groups`, and `weight`; it does not report artifact completion.

### Compare the automatic path

For an export that does not need operator approval, use a **new** report ID and set `releasePolicy` to `automatic` in the same request. It still observes the five-second durable delay, but it bypasses the release barrier; poll it as admin until it succeeds. An automatic artifact has `releasedBy: null`.

`ReportExport.Generate` takes the identical request but waits for completion, which is useful for the automatic path. It returns the report result directly (`artifactPath`, totals, and the other result fields), without `Poll`'s `_tag` wrapper. Do not use it alone for an approval-gated report: it remains waiting until an operator releases that execution from another client. `ReportExport.GenerateResume` resumes a `Recoverable` execution with the same execution ID and durable journal; it does not create replacement work. `ReportExport.Cancel` cancels `accepted` or `dispatched` work and safely interrupts a dispatched native execution. Cancellation is rejected after artifact writing starts. `ReportExport.Reconcile` is valid only for a succeeded execution: it recreates a missing deterministic artifact, returns an identical existing artifact, and rejects conflicting bytes.

## Identity, access, and safe retries

The caller never sends an account ID. Generation derives it from the authenticated subject's tenant, and the durable execution key is the pair of that account and `report.reportId`. Consequently:

- Repeating the same report ID for the same account addresses the same execution. It is not an update or a replacement for changed lines. Use a fresh report ID for different source data.
- Alice's issued Acme editor credential can generate in the newly seeded database. An issued Bob credential is a reader and fails the editor policy. An issued `outsider` credential is an editor in the `other` account but has no seeded paid subscription, so generation fails its `reports.generate` entitlement. The issued Admin credential is the global operator for polling, release, cancellation, recovery, reconciliation, status, and `GET /operator/metrics`; operator access does not require a subscription.
- The subscription resolver checks the stored row and clock on each generation request. Cancellation retains access until `validUntil`; a canceled row can use a non-null `graceUntil` until that exclusive timestamp. Restarting never renews, restores, or seeds over an existing subscription.
- Once a workflow has been accepted, its durable steps do not re-check the generation entitlement. That lets already accepted work continue after the subscription changes; it does not authorize a new generation.

The request is deliberately constrained: report IDs start alphanumeric and may then contain letters, numbers, `.`, `_`, or `-` (up to 128 characters); account codes are 4–10 digits; currencies are `AUD`, `CAD`, `EUR`, `GBP`, `JPY`, or `USD`; every line has a nonempty description, `debit` or `credit` direction, and a positive safe-integer `amountMinor`. The reporting period must end after it starts. Schema failures exit nonzero, while arithmetic that cannot be represented safely fails the workflow. There is no external ledger lookup, provider, webhook, checkout, or credit-consumption simulation.

## Web, MCP, and operations

At `http://127.0.0.1:3001/`, the Foldkit page starts signed out and provides the shared login form. It uses canonical native clients and retains issued bearer tokens only in memory. An editor can submit a generated request; an administrator can enter an execution ID to poll, release, cancel, resume, reconcile, or inspect runner status. Session changes clear drafts and prior execution state, and field errors are shown for invalid form values. The page has no generated admin area. The same published operations are available as protected MCP tools at `http://127.0.0.1:3001/mcp`; provide the bearer token on every tool call and wrap a request as `{ "input": <RPC payload> }`. A successful MCP tool result is `structuredContent.result`; declared errors have `isError: true`.

The default `EFFECT_CLUSTER_MODE=single` keeps the local one-process workflow. `runner` starts a native Bun HTTP runner and all workflow/queue workers. `client` starts application HTTP/RPC plus the outbox relay, but not runner registrations. Colocated runners coordinate through one execution SQLite file:

```bash
# terminal 1
EFFECT_CLUSTER_MODE=runner EFFECT_CLUSTER_PORT=34431 \
  EFFECT_CLUSTER_LISTEN_PORT=34431 bun run report-exports:worker

# terminal 2
EFFECT_CLUSTER_MODE=runner EFFECT_CLUSTER_PORT=34432 \
  EFFECT_CLUSTER_LISTEN_PORT=34432 bun run report-exports:worker

# terminal 3
EFFECT_CLUSTER_MODE=client PORT=3001 bun run report-exports:server
```

All three processes must share `REPORT_EXPORTS_DB`, `REPORT_EXPORTS_EXECUTION_DB`, `REPORT_EXPORTS_IDENTITY_DB`, and `REPORT_EXPORTS_OUTPUT_DIR`. This is a colocated SQLite deployment, not cross-host storage. Runner addresses must be distinct and reachable. `EFFECT_CLUSTER_HOST` and `EFFECT_CLUSTER_LISTEN_HOST` default to `127.0.0.1`; the advertised and listen ports default to `EFFECT_CLUSTER_PORT` and `34431`.

Startup records topology version, shard count, and sorted shard groups in the execution database and rejects drift before background work starts. Same-topology binary upgrades may replace runners one at a time after a backup and a health check. Any topology, shard-count, or native execution-store compatibility change requires a maintenance window: stop clients and runners, back up both databases and artifacts, apply the native Effect-supported storage migration, advance the version in `clusterRuntimeLayer("report-exports", ...)`, and run the documented `advanceClusterTopology` compare-and-set against the stopped execution database before starting version-matched processes. Never start mixed topology versions. Follow the exact [topology-change procedure and runnable deployment Effect](../../docs/reference/runtime.md#change-durable-topology).

The application database defaults to `data/report-exports.sqlite`; execution storage defaults to `data/report-exports-execution.sqlite`; `REPORT_EXPORTS_OUTPUT_DIR` is required. Back up application and execution databases plus artifacts as one recovery set, while recognizing their transaction boundaries are separate. The application-owned execution row is a transactional outbox for acceptance and at-least-once dispatch. Deterministic native IDs make repeat dispatch safe. The immutable artifact sink and `Reconcile` make its exercised external effect idempotent; none of this promises general exactly-once behavior across arbitrary external systems.

`EFFECT_DOMAINS_DEMO_PASSWORD` is required at every server start and `REPORT_EXPORTS_IDENTITY_DB` defaults to `data/report-exports-identity.sqlite`; configure it separately from `REPORT_EXPORTS_DB` and `REPORT_EXPORTS_EXECUTION_DB`.

For source details, see the [workflow and RPCs](workflow.ts), [contracts](contracts.ts), [authorization](authorization.ts), [subscription resolver](subscriptions.ts), [runtime layer](runtime.ts), [artifact writer](writer.ts), and the shared [runtime reference](../../docs/reference/runtime.md#durable-execution).