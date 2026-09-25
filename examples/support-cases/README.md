# Support cases: joined board and transactional history

[All examples](../README.md)

Register customers and agents, open support cases, and advance each case through triage, assignment, resolution, and reopening. The current board is a bounded `ReadModel`; the nested event history stays an authored SQL projection.

The final runtime composes two sibling applications. `SupportDirectory` owns customers and agents; `CaseManagement` owns cases, events, the joined board, and authored lifecycle commands. Relations and command dependencies cross that child boundary and are validated only when the `Application.compile` Effect flattens the complete tree at the application composition boundary.

## Run it

Use Bun from the repository root with separate disposable application and identity SQLite files:

```bash
bun install
bun run build
export EFFECT_DOMAINS_DEMO_PASSWORD='a-local-demo-secret'
export SUPPORT_CASES_DB="$(mktemp -d)/support-cases.sqlite"
export SUPPORT_CASES_IDENTITY_DB="$(mktemp -d)/support-cases-identity.sqlite"
bun run support-cases:server
```

The server provides:

- The generated Application UI with authored presentation at [http://127.0.0.1:3000/](http://127.0.0.1:3000/).
- An optional, application-owned guided intake at [http://127.0.0.1:3000/intake](http://127.0.0.1:3000/intake).
- Effect JSON RPC at `http://127.0.0.1:3000/rpc/v1`.
- Streamable HTTP MCP at `http://127.0.0.1:3000/mcp`.

Customer lookup and case opening are public operations; no bearer token is required for this flow. Other operations such as `support.auditTrail` still require the server's normal identity and authorization checks. Keep this demonstration server on loopback.

## Register a customer and agents

In another terminal at the repository root:

```bash
bun run support-cases support_customers.create --input-json '{"id":"acme","name":"Acme Industries"}'
bun run support-cases support_agents.create --input-json '{"id":"sam","name":"Sam","onDuty":false}'
```

Customer and agent identifiers are canonical nonempty strings. Agent duty state is current joined data; cases do not copy the agent name or duty flag.

## Open and query a case

```bash
bun run support-cases support.openCase --input-json '{"customerId":"acme","subject":"Cannot export quarterly report","priority":"high"}'
bun run support-cases support.board --input-json '{"filter":{"status":"open","priority":"high"},"limit":10}'
```

Copy the generated case `id` into a shell variable:

```bash
CASE_ID='paste-the-case-id-here'
```

`support.openCase` writes the case and its initial `opened` event in one transaction. The case starts at status `open`, version `1`, and no assigned agent. Omit `priority` to use `normal`.

The board joins each case to its required customer and optional assigned agent. It returns `{ items, nextCursor }`, accepts equality filters on customer, priority, status, and assignment, accepts inclusive `openedAt` bounds, and orders newest first with the case identifier as a stable tiebreaker.

## Triage and assign

```bash
bun run support-cases support.advanceCase --input-json "{\"caseId\":\"$CASE_ID\",\"expectedVersion\":1,\"action\":\"triage\",\"note\":\"Reproduced from the export payload.\"}"
bun run support-cases support.advanceCase --input-json "{\"caseId\":\"$CASE_ID\",\"expectedVersion\":2,\"action\":\"assign\",\"assignedAgentId\":\"sam\"}"
```

The first command returns status `triaged`, version `2`, and appends a `triaged` event. The assignment fails with `AgentOffDuty`; neither the case nor its history changes.

Put Sam on duty and repeat the assignment:

```bash
bun run support-cases support_agents.patch --input-json '{"key":"sam","changes":{"onDuty":true}}'
bun run support-cases support.advanceCase --input-json "{\"caseId\":\"$CASE_ID\",\"expectedVersion\":2,\"action\":\"assign\",\"assignedAgentId\":\"sam\"}"
```

The case becomes `assigned` at version `3`. Assignment requires an existing on-duty agent. `triage`, `resolve`, and `reopen` do not accept assignment as business policy; reopening clears the current assignment.

## Resolve and inspect history

```bash
bun run support-cases support.advanceCase --input-json "{\"caseId\":\"$CASE_ID\",\"expectedVersion\":3,\"action\":\"resolve\",\"note\":\"Export permission repaired.\"}"
bun run support-cases support.caseDetail --input-json "{\"caseId\":\"$CASE_ID\"}"
```

The detail result contains the current case, current customer, current assigned agent or `null`, and the ordered event array. `Table.project` supplies physical codecs and JSON object fragments, but the correlated one-to-many event query remains authored SQL. `ReadModel` handles only the flat board projection; no aggregate or relationship query language was added.

A stale `expectedVersion` fails with `VersionConflict` and appends no event. An invalid edge fails with `InvalidSupportCaseTransition`. The declared graph is:

```text
open --triage--> triaged --assign--> assigned --resolve--> resolved
                         ^                            |
                         +-----------reopen----------+
```

## Use the Application UI, guided intake, or MCP

The generated UI at `/` exposes published resource reads, customer and agent CRUD, the joined board, and authored support operations. Its `ui.presentation` supplies the **Support operations** title, resource and operation labels, descriptions, and deliberate table columns. These values affect presentation only; inspected schemas and server-side authorization remain authoritative. Case/event creation and transitions still use `support.openCase` and `support.advanceCase` so event history shares the transaction.

The optional `/intake` page uses the published `effect-machine@0.27.0` package only in this example. Its browser-local actor owns the `Customer → LookingUp → Editing → Submitting → Complete/Failed` interaction. Back-navigation interrupts the in-flight customer lookup; submissions are disabled while the first command is pending. The browser calls `support_customers.get` and finally `support.openCase` through the same `/api/call` boundary as the generated UI. The authoritative case, history, and audit writes are still the command's SQLite transaction, not actor state. A failed or interrupted submission may have committed on the server: inspect the case list before submitting another. Reloading or closing the tab discards the draft and actor; it does not undo a committed case. The page does not persist or replay a session.

For MCP, call the same operations with arguments shaped as `{ "input": <RPC payload> }`. A successful tool result is `{ "result": <RPC result> }`.

## Runtime and persistence

| Setting | Default | Meaning |
| --- | --- | --- |
| `SUPPORT_CASES_DB` | `data/support-cases.sqlite` | Application SQLite file |
| `SUPPORT_CASES_IDENTITY_DB` | Private store default | Separate example identity SQLite file |
| `EFFECT_DOMAINS_DEMO_PASSWORD` | Required | Local identity bootstrap secret |
| `PORT` | `3000` | Loopback server port |
| `SUPPORT_CASES_URL` | `http://127.0.0.1:3000/rpc/v1` | Remote CLI endpoint |

The imported `001_initial.json` and `002_audit.json` artifacts create the domain and audit tables, foreign keys, indexes, and migration ledger. Restarting with the same database preserves cases, history, and audit evidence. Startup checks the artifact ledger and exact managed schema rather than adopting untracked objects.

## Full-stack OpenTelemetry and durable audit

The runtime exports OTLP traces, metrics, and correlated logs as `support-cases`, while the generated browser exports through the same-origin gateway as `support-cases-browser`. This nested application demonstrates one correlated runtime boundary across generated resources, authored transactions, the joined board, Application UI, MCP, and CLI:

```bash
bun run observability:up
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:14318
bun run support-cases:server

# In another terminal with the same endpoint:
bun run support-cases support.board --input-json '{"filter":{"status":"open"}}'
```

`support.auditTrail` is admin-only. Every successful lifecycle transition appends one typed record in the same SQLite transaction as case state and history. Failed and rolled-back transitions append none; stable case/version IDs make retries idempotent. Audit persistence does not depend on OTLP. No telemetry endpoint means no runtime-owned exporter or browser gateway traffic.

## Follow the implementation

- [`domain.ts`](domain.ts): canonical customer, agent, case, event, payload, transition, and failure schemas.
- [`resources.ts`](resources.ts): public authorization, generated reads, private creation policies, versions, foreign keys, and list declarations.
- [`board.ts`](board.ts): the flat customer/agent `ReadModel` and bounded keyset page.
- [`contracts.ts`](contracts.ts): the nested case-detail result.
- [`audit.ts`](audit.ts): private typed lifecycle records, deterministic identifiers, and authorized history reads.
- [`sqlite.ts`](sqlite.ts): transactional open/advance handlers and the authored nested history query.
- [`intake-machine.ts`](intake-machine.ts), [`intake-client.ts`](intake-client.ts), and [`intake-route.ts`](intake-route.ts): application-owned transient protocol, browser request adapter, and route assets.
- [`application.ts`](application.ts): sibling directory/case-management applications and final composition.
- [`main.ts`](main.ts): migration history, Application UI presentation, optional intake route, OTLP resource metadata, and runner.

This slice exercises version, transition, list range/order, operation transaction, joined projection, authored-query, sibling-application composition, runtime-owned UI presentation, and telemetry configuration seams together in another domain.
