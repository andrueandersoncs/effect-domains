# Team tasks: tenant-owned operational work

This application tracks work that a team has committed to complete: the project it belongs to, a concise task title, optional working detail and due date, a priority, and whether it is complete. Each task is owned by a member of one tenant. `Resource.make` supplies the repository, RPC procedures, patch handling, list operation, and storage; the domain still explicitly authors its authorization policy.

## Policy and generated operations

[`resources.ts`](resources.ts) keeps ownership and completion status as business rules rather than inferring them from the schema:

- A caller sees tasks only in their tenant. Owners can read their own tasks; tenant administrators can read every task.
- Creation binds `tenantId` and `ownerId` from the authenticated subject. Those fields are not accepted from a client.
- Owners can update or patch an incomplete task, including marking it complete. Once complete, only an administrator can reopen or otherwise edit it.
- Neither an owner nor an administrator can transfer a task or move it between tenants. Only administrators can remove tasks.

The generated historical `todos` resource accepts equality filters for `project`, `priority`, and `completed`, with a page limit from 1 through 25. It applies visibility before filtering and cursor pagination, orders by identifier ascending, and returns `{ items, nextCursor }`. `patch` accepts `{ key, changes }`; `update` requires the complete task row. The application and domain are named team tasks; keeping this resource name preserves the applied `todos` table history.

`project` and `title` are non-empty. New tasks default to `priority: "normal"`, `detail: null`, `dueDate: null`, and `completed: false`. Priority is one of `low`, `normal`, `high`, or `urgent`; a non-null due date must be a real Gregorian `YYYY-MM-DD` calendar date. The example deliberately does not provide scheduling, reminders, dependencies, assignments beyond the owner, or cross-project reporting.

## Run the field-work scenario

Start the loopback server from the repository root:

```bash
bun run team-tasks:server
```

Alice records a high-priority pressure-test follow-up for the North Yard project:

```bash
export TEAM_TASKS_TOKEN=alice-demo
bun run team-tasks todos.create --input-json '{"project":"North Yard pump inspection","title":"Attach pressure-test photo","detail":"Use the calibrated 0-200 psi gauge record from the site tablet.","priority":"high","dueDate":"2026-09-18"}'
bun run team-tasks todos.list --input-json '{"filter":{"project":"North Yard pump inspection","completed":false},"limit":10}'
```

Set `TASK_ID` to the identifier returned by creation. Alice can complete the task, but then cannot alter it:

```bash
bun run team-tasks todos.patch --input-json "{\"key\":\"$TASK_ID\",\"changes\":{\"completed\":true}}"
bun run team-tasks todos.patch --input-json "{\"key\":\"$TASK_ID\",\"changes\":{\"detail\":\"Late calibration note\"}}"
```

The second command exits nonzero with `Forbidden` and leaves the completed task unchanged. Bob cannot read Alice's task, even though both demo identities belong to Acme:

```bash
TEAM_TASKS_TOKEN=bob-demo bun run team-tasks todos.get --input-json "{\"id\":\"$TASK_ID\"}"
```

An Acme administrator can reopen the task but cannot change its tenant or owner:

```bash
TEAM_TASKS_TOKEN=admin-demo bun run team-tasks todos.update --input-json "{\"id\":\"$TASK_ID\",\"project\":\"North Yard pump inspection\",\"title\":\"Attach pressure-test photo\",\"detail\":\"Use the calibrated 0-200 psi gauge record from the site tablet.\",\"priority\":\"high\",\"dueDate\":\"2026-09-18\",\"completed\":false,\"tenantId\":\"acme\",\"ownerId\":\"alice\"}"
TEAM_TASKS_TOKEN=admin-demo bun run team-tasks todos.patch --input-json "{\"key\":\"$TASK_ID\",\"changes\":{\"ownerId\":\"bob\"}}"
```

The transfer attempt is forbidden. The four public demo tokens are intentionally local-only fixtures: `alice-demo` is Acme editor Alice, `bob-demo` is Acme reader Bob, `admin-demo` is the Acme administrator, and `outsider-demo` is Alice in another tenant. They are not an identity system.

## Runtime and persistence

| Setting | Default | Meaning |
| --- | --- | --- |
| `TEAM_TASKS_DB` | `team-tasks.sqlite` | SQLite database file used by the server |
| `TEAM_TASKS_URL` | `http://127.0.0.1:3000/rpc/v1` | RPC endpoint used by the CLI |
| `TEAM_TASKS_TOKEN` | unset | Demo bearer token sent by the CLI |
| `PORT` | `3000` | Loopback HTTP port |

For a concurrent instance, configure the server and CLI endpoint together:

```bash
PORT=3001 TEAM_TASKS_DB=team-tasks-demo.sqlite bun run team-tasks:server
TEAM_TASKS_URL=http://127.0.0.1:3001/rpc/v1 TEAM_TASKS_TOKEN=alice-demo bun run team-tasks todos.list
```

[`004_task_details`](migrations/004_task_details.json) preserves the frozen todo history and rebuilds the same table. Existing rows retain their identifier, title, completion state, tenant, and owner; the migration backfills `project` as `"Unassigned project"`, `priority` as `"normal"`, and nullable `detail` and `dueDate` as `null`. Review and classify those backfilled tasks before operational use.

Inspection is local and needs no server or token:

```bash
bun run team-tasks inspect todos.patch
```

See the [examples overview](../README.md), [expense-ledger](../README.md#expense-ledger), and [encrypted field reports](../field-notes/README.md).
