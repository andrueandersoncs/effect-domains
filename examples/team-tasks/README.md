# Team tasks: tenant-owned operational work

This guide runs a small task board through the same authenticated RPC operations used by its generated Application UI. Create two Acme tasks as Alice, page the filtered list, show that Bob cannot see Alice's work, complete a task, then manage a permission-gated tenant report through group membership.

The application has a generated resource, historically named `todos`, and an authored `todos.review` aggregate. Its [canonical task fields](domain.ts) are project, title, optional detail and due date, priority, completion state, and server-returned tenant and owner fields. The report is explicit application SQL guarded by a persisted permission, not an inferred Resource capability.

## Before you start

Run every command below from the repository root with Bun installed. Install workspace dependencies and build the shared Application UI assets before starting a server:

```bash
bun install
bun run build
```

Use fresh, separate databases for the task data and example identity state. They avoid collisions with another local example and make the expected list results reproducible. In the **server terminal**, start the loopback server:

```bash
export PORT=3001
export TEAM_TASKS_DB="$(mktemp -d)/team-tasks.sqlite"
export TEAM_TASKS_IDENTITY_DB="$(mktemp -d)/team-tasks-identity.sqlite"
export EFFECT_DOMAINS_DEMO_PASSWORD='choose-a-local-bootstrap-password'
bun run team-tasks:server
```

`EFFECT_DOMAINS_DEMO_PASSWORD` is required on every start, and `TEAM_TASKS_IDENTITY_DB` must not be `TEAM_TASKS_DB`. The seed accounts are inserted only once; the setting does not reset changed credentials, roles, or disabled state. In a separate **client terminal**, point the CLI at that server and issue the credentials the walkthrough needs:

```bash
export TEAM_TASKS_URL=http://127.0.0.1:3001/rpc/v1
export DEMO_PASSWORD='choose-a-local-bootstrap-password' # same value used by the server
issue_team_token() {
  bun run team-tasks identity.login --input-json "$(
    bun -e 'const [username, password] = process.argv.slice(2); if (!password) throw new Error("DEMO_PASSWORD is required"); console.log(JSON.stringify({ username, password }))' "$1" "$DEMO_PASSWORD"
  )" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).token)'
}
export TEAM_TASKS_TOKEN="$(issue_team_token alice)"
export BOB_TOKEN="$(issue_team_token bob)"
export ADMIN_TOKEN="$(issue_team_token admin)"
```

The token is a per-call bearer credential; do not print or commit it. `bun run team-tasks identity.current` displays the verified subject and expiry, and `identity.logout` revokes the token currently in `TEAM_TASKS_TOKEN`. Sessions expire (eight hours by default); see [example identity](../README.md#example-identity) for the shared lifecycle and bootstrap details.

## Run it

Create two tasks in the same project. The create request deliberately has no `id`, `tenantId`, `ownerId`, or `completed` fields. The server creates the UUID identifier, binds tenant and owner from Alice's authenticated claims, and supplies `completed: false`, `detail: null`, `dueDate: null`, and `priority: "normal"` when those optional create values are omitted.

```bash
bun run team-tasks todos.create --input-json '{"project":"North Yard pump inspection","title":"Attach pressure-test photo","detail":"Use the calibrated 0-200 psi gauge record from the site tablet.","priority":"high","dueDate":"2026-09-18"}'
bun run team-tasks todos.create --input-json '{"project":"North Yard pump inspection","title":"Record the isolation-valve serial number"}'
```

Each success prints a complete task JSON object. Copy the first returned `id` string and assign it manually in the same client terminal:

```bash
export TASK_ID='paste-the-first-returned-id-here'
```

Notice that the first returned task has `"tenantId":"acme"` and `"ownerId":"alice"` even though neither appeared in the request. A caller that adds either field to create input is rejected; they are not client-settable task attributes.

### Page the list and use only declared filters

The list supports equality filters only for `project`, `priority`, and `completed`. Its configured limit is both the default and maximum: an omitted limit returns up to 25 tasks, and accepted explicit limits are integers from 1 through 25. Results are identifier-ascending, visibility is applied before the filter and pagination, and each response has `{ "items": [...], "nextCursor": string | null }`.

Request one matching task per page:

```bash
bun run team-tasks todos.list --input-json '{"filter":{"project":"North Yard pump inspection"},"limit":1}'
```

Copy the non-null `nextCursor` string from that response exactly, without decoding or editing it:

```bash
export TASK_CURSOR='paste-the-returned-nextCursor-here'
bun run team-tasks todos.list --input-json "{\"filter\":{\"project\":\"North Yard pump inspection\"},\"limit\":1,\"cursor\":\"$TASK_CURSOR\"}"
```

The second call returns the other task and normally `nextCursor: null`. Keep the filter unchanged when reusing a cursor. A malformed cursor, a cursor made for another filter, a limit above 25, or an undeclared filter such as `ownerId` is rejected. There is no search, partial match, custom sort, unbounded list, or separate page operation.

### See ownership and role boundaries

Alice can fetch and complete the task she owns:

```bash
bun run team-tasks todos.get --input-json "{\"id\":\"$TASK_ID\"}"
bun run team-tasks todos.patch --input-json "{\"key\":\"$TASK_ID\",\"changes\":{\"completed\":true}}"
```

`patch` takes `{ key, changes }`; `changes` is partial, cannot contain `id`, and is validated after merging with the current task. A successful call returns the complete changed task. Once the task is completed, an owner can no longer change it—not even its detail:

```bash
bun run team-tasks todos.patch --input-json "{\"key\":\"$TASK_ID\",\"changes\":{\"detail\":\"Late calibration note\"}}"
```

This exits nonzero with `Forbidden` and leaves the completed task unchanged. A reader in the same tenant is also not an owner. Bob's list has no matching visible row, and a direct lookup reports `ResourceNotFound` rather than revealing Alice's task:

```bash
TEAM_TASKS_TOKEN="$BOB_TOKEN" bun run team-tasks todos.list --input-json '{"filter":{"project":"North Yard pump inspection"}}'
TEAM_TASKS_TOKEN="$BOB_TOKEN" bun run team-tasks todos.get --input-json "{\"id\":\"$TASK_ID\"}"
```

The list response has an empty `items` array; the get command exits nonzero. An issued credential for `outsider` is similarly outside the tenant scope. Missing, expired, revoked, or unknown bearer credentials fail with `Unauthenticated`.

An Acme administrator can read every Acme task, reopen a completed task, and remove it. `update` is replacement, so it requires the complete canonical row, including `id`, `tenantId`, and `ownerId`:

```bash
TEAM_TASKS_TOKEN="$ADMIN_TOKEN" bun run team-tasks todos.update --input-json "{\"id\":\"$TASK_ID\",\"project\":\"North Yard pump inspection\",\"title\":\"Attach pressure-test photo\",\"detail\":\"Use the calibrated 0-200 psi gauge record from the site tablet.\",\"priority\":\"high\",\"dueDate\":\"2026-09-18\",\"completed\":false,\"tenantId\":\"acme\",\"ownerId\":\"alice\"}"
TEAM_TASKS_TOKEN="$ADMIN_TOKEN" bun run team-tasks todos.patch --input-json "{\"key\":\"$TASK_ID\",\"changes\":{\"ownerId\":\"bob\"}}"
TEAM_TASKS_TOKEN="$ADMIN_TOKEN" bun run team-tasks todos.remove --input-json "{\"id\":\"$TASK_ID\"}"
```

The update reopens the task. The attempted transfer exits nonzero with `Forbidden`: administrators may edit a task but cannot move it between tenants or change its owner. The final remove succeeds and returns no value. Owners and readers cannot remove a task.

`project` and `title` must be non-empty. `priority` is exactly `low`, `normal`, `high`, or `urgent`; a non-null due date must be a real Gregorian `YYYY-MM-DD` date. For example, this malformed date is rejected before it creates a row:

```bash
bun run team-tasks todos.create --input-json '{"project":"North Yard pump inspection","title":"Impossible date","dueDate":"2026-02-30"}'
```

### Manage groups and permissions

`todos.review` counts tasks across the authenticated tenant, including other owners' tasks. Unlike `todos.list`, it requires an exact `todos.review` permission. Bob initially receives `Forbidden`:

```bash
TEAM_TASKS_TOKEN="$BOB_TOKEN" bun run team-tasks todos.review
```

An Acme admin can create a group, manage active same-tenant members, and grant the group the report permission:

```bash
export GROUP_ID="$(
  TEAM_TASKS_TOKEN="$ADMIN_TOKEN" bun run team-tasks identity.group.create --input-json '{"name":"Review team"}' \
    | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).id)'
)"
TEAM_TASKS_TOKEN="$ADMIN_TOKEN" bun run team-tasks identity.group.addMember --input-json "{\"id\":\"$GROUP_ID\",\"username\":\"bob\"}"
TEAM_TASKS_TOKEN="$ADMIN_TOKEN" bun run team-tasks identity.permission.grantGroup --input-json "{\"id\":\"$GROUP_ID\",\"permission\":\"todos.review\"}"
TEAM_TASKS_TOKEN="$ADMIN_TOKEN" bun run team-tasks identity.group.listMembers --input-json "{\"id\":\"$GROUP_ID\"}"
TEAM_TASKS_TOKEN="$BOB_TOKEN" bun run team-tasks identity.group.isMember --input-json "{\"id\":\"$GROUP_ID\",\"username\":\"bob\"}"
TEAM_TASKS_TOKEN="$BOB_TOKEN" bun run team-tasks todos.review
```

The final result has `total` and `completed` integer counts for Acme only. Group names can be changed with `identity.group.update({ id, name })`. Members can list their own group, but only the tenant admin changes membership/grants or lists a group's grants. Direct per-account grants are independent:

```bash
TEAM_TASKS_TOKEN="$ADMIN_TOKEN" bun run team-tasks identity.permission.grantAccount --input-json '{"username":"alice","permission":"todos.review"}'
bun run team-tasks identity.permission.listAccount --input-json '{"username":"alice"}'
TEAM_TASKS_TOKEN="$ADMIN_TOKEN" bun run team-tasks identity.permission.revokeAccount --input-json '{"username":"alice","permission":"todos.review"}'
```

The original `TEAM_TASKS_TOKEN` still belongs to Alice; per-command overrides do not change it. `listAccount` lists only direct grants, not grants inherited from groups. Remove Bob from the group to revoke report access immediately:

```bash
TEAM_TASKS_TOKEN="$ADMIN_TOKEN" bun run team-tasks identity.group.removeMember --input-json "{\"id\":\"$GROUP_ID\",\"username\":\"bob\"}"
TEAM_TASKS_TOKEN="$BOB_TOKEN" bun run team-tasks identity.permission.check --input-json '{"permission":"todos.review"}'
TEAM_TASKS_TOKEN="$BOB_TOKEN" bun run team-tasks todos.review
TEAM_TASKS_TOKEN="$ADMIN_TOKEN" bun run team-tasks identity.group.delete --input-json "{\"id\":\"$GROUP_ID\"}"
```

`check` returns `false`; `todos.review` exits nonzero with `Forbidden`. Deleting a group transactionally removes its remaining memberships and grants. An admin can issue `identity.issueInvite` for another person to join Acme; `identity.signup({ username, password, inviteToken })` consumes it once and returns that new reader's session. A signup without an invitation creates a separate tenant and cannot be silently added to Acme. Password-reset issuance is admin-only and requires out-of-band credential delivery; see the [identity runtime reference](../../docs/reference/runtime.md#identity-services-and-rpc).

The example intentionally does not add scheduling, reminders, dependencies, reassignment, or a production identity flow.

## Application UI and MCP

With the server running, open [http://127.0.0.1:3001/](http://127.0.0.1:3001/). Run `identity.login` with a seeded account, or `identity.signup` for a new isolated tenant; the generated UI keeps the returned bearer token only in memory and clears it on logout or closure. It derives task operation forms, exact project/priority/status filters, and cursor paging from the compiled application. Tenant and owner fields remain server-owned, and authorization failures remain visible.

Streamable HTTP MCP is available at `http://127.0.0.1:3001/mcp`. Tool arguments wrap the RPC payload as `{ "input": <payload> }`; MCP does not bypass task policy.

## Settings, persistence, and inspection

| Setting | Default | Used by | Meaning |
| --- | --- | --- | --- |
| `TEAM_TASKS_DB` | `data/team-tasks.sqlite` | server | SQLite database path |
| `TEAM_TASKS_IDENTITY_DB` | `data/team-tasks-identity.sqlite` | server | Separate SQLite identity store |
| `PORT` | `3000` | server | loopback HTTP port |
| `TEAM_TASKS_URL` | `http://127.0.0.1:3000/rpc/v1` | CLI | RPC endpoint |
| `TEAM_TASKS_TOKEN` | unset | CLI | bearer token sent to each RPC call |

The server binds to `127.0.0.1`; `PORT` does not update `TEAM_TASKS_URL`. Reuse the same database path to retain tasks after a restart. The ordered, frozen [migration history](migrations.ts) includes [`004_task_details`](migrations/004_task_details.json), which rebuilt the historical `todos` table and backfilled older rows with project `"Unassigned project"`, priority `"normal"`, and null detail/due date. Review those backfilled rows before treating them as classified work. Startup applies tracked history and rejects an untracked database rather than guessing its schema.
Databases created before the v2 artifact format must be recreated; startup reports `MigrationError: migration history changed at 001_initial`.

Inspection is local and does not need a server or token:

```bash
bun run team-tasks inspect todos.patch
```

For the common wire, pagination, error, and endpoint contracts, see the [runtime reference](../../docs/reference/runtime.md) and [resource reference](../../docs/reference/resources.md). The task-specific policy and create binding are in [`resources.ts`](resources.ts); [`main.ts`](main.ts) configures identity, migrations, and Application UI presentation.

[All examples](../README.md) · [Field notes: global reports with encrypted bodies](../field-notes/README.md)
