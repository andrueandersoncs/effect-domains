# Support cases: joined board and transactional history

[All examples](../README.md)

Register customers and agents, open support cases, and advance each case through triage, assignment, resolution, and reopening. The current board is a bounded `SqliteView`; the nested event history stays an authored SQL projection. This public loopback example is not a production ticketing, identity, or notification system.

## Run it

Use Bun from the repository root with a disposable SQLite file:

```bash
bun install
bun run build
export SUPPORT_CASES_DB="$(mktemp -d)/support-cases.sqlite"
bun run support-cases:server
```

The server provides:

- A hand-authored Foldkit case board at [http://127.0.0.1:3000/](http://127.0.0.1:3000/).
- Generated administration at [http://127.0.0.1:3000/admin](http://127.0.0.1:3000/admin).
- Effect JSON RPC at `http://127.0.0.1:3000/rpc/v1`.
- Streamable HTTP MCP at `http://127.0.0.1:3000/mcp`.

No bearer token is required. Keep this demonstration server on loopback.

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

The detail result contains the current case, current customer, current assigned agent or `null`, and the ordered event array. `Table.project` supplies physical codecs and JSON object fragments, but the correlated one-to-many event query remains authored SQL. `SqliteView` handles only the flat board projection; no aggregate or relationship query language was added.

A stale `expectedVersion` fails with `VersionConflict` and appends no event. An invalid edge fails with `InvalidSupportCaseTransition`. The declared graph is:

```text
open --triage--> triaged --assign--> assigned --resolve--> resolved
                         ^                            |
                         +-----------reopen----------+
```

## Use the browser, admin, or MCP

The Foldkit page can register customers and agents, open cases, filter and inspect the board, review event history, and advance the selected case. The page uses the same native RPC contracts as the CLI and suppresses repeated local mutations while one is pending.

The generated admin exposes the published resource reads, customer and agent CRUD, board, and authored support operations. Case/event creation and case transitions are not published as generated resource mutations; callers must use `support.openCase` and `support.advanceCase` so the event history shares the transaction.

For MCP, call the same operations with arguments shaped as `{ "input": <RPC payload> }`. A successful tool result is `{ "result": <RPC result> }`.

## Runtime and persistence

| Setting | Default | Meaning |
| --- | --- | --- |
| `SUPPORT_CASES_DB` | `data/support-cases.sqlite` | Application SQLite file |
| `PORT` | `3000` | Loopback server port |
| `SUPPORT_CASES_URL` | `http://127.0.0.1:3000/rpc/v1` | Remote CLI endpoint |

The imported `001_initial.json` artifact creates four tables, foreign keys, indexes, and the migration ledger. Restarting with the same database preserves cases and history. Startup checks the artifact ledger and exact managed schema rather than adopting untracked objects.

## Follow the implementation

- [`domain.ts`](domain.ts): canonical customer, agent, case, event, payload, transition, and failure schemas.
- [`resources.ts`](resources.ts): public authorization, generated reads, private creation policies, versions, foreign keys, and list declarations.
- [`board.ts`](board.ts): the flat customer/agent `SqliteView` and bounded keyset list.
- [`contracts.ts`](contracts.ts): the nested case-detail result.
- [`sqlite.ts`](sqlite.ts): transactional open/advance handlers and the authored nested history query.
- [`application.ts`](application.ts), [`main.ts`](main.ts): application composition, frozen migration history, generated admin, and static browser routes.
- [`web/main.ts`](web/main.ts): the authored case-management workflow.

This slice adds no framework API. It exercises the existing version, transition, list range/order, operation transaction, joined projection, and authored-query escape hatches together in another domain.
