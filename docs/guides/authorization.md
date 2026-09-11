# Restrict access to tenant-owned records

Use this guide when a resource must expose each row only to the authenticated tenant and its owner, while allowing a tenant administrator to manage the tenant's rows. It uses the current `team-tasks` application and Bun workspace commands.

## Start an isolated demonstration

From the repository root, install the workspace and build the optional admin assets once:

```bash
bun install
bun run build
```

In the first terminal, start fresh application and identity stores. `EFFECT_DOMAINS_DEMO_PASSWORD` is required to seed the example accounts; keep the identity database physically separate from the application database.

```bash
DEMO_DIR="$(mktemp -d)"
export EFFECT_DOMAINS_DEMO_PASSWORD='correct-horse-battery-staple'
PORT=3001 \
  TEAM_TASKS_DB="$DEMO_DIR/team-tasks.sqlite" \
  EFFECT_DOMAINS_IDENTITY_DB="$DEMO_DIR/identity.sqlite" \
  bun run team-tasks:server
```

In a second terminal at the repository root, configure the CLI and obtain Alice's issued credential. Examples start signed out. The helper constructs JSON with Bun rather than interpolating the password into shell JSON, and captures the secret credential instead of printing it:

```bash
export TEAM_TASKS_URL=http://127.0.0.1:3001/rpc/v1
export EFFECT_DOMAINS_DEMO_PASSWORD='correct-horse-battery-staple'
login_input() {
  bun -e 'console.log(JSON.stringify({ username: process.argv[1], password: process.env.EFFECT_DOMAINS_DEMO_PASSWORD }))' "$1"
}
login_token() {
  bun run team-tasks identity.login --input-json "$(login_input "$1")" |
    bun -e 'console.log(JSON.parse(await Bun.stdin.text()).token)'
}
export TEAM_TASKS_TOKEN="$(login_token alice)"
bun run team-tasks todos.create --input-json '{"project":"North Yard pump inspection","title":"Attach pressure-test photo","detail":"Use the calibrated 0-200 psi gauge record from the site tablet.","priority":"high","dueDate":"2026-09-18"}'
```

Creation succeeds and returns a task with `tenantId: "acme"`, `ownerId: "alice"`, and an `id`. Those identity fields are absent from the input. Set `TASK_ID` in the second terminal to that returned `id`, then confirm that Alice can see the task:

```bash
bun run team-tasks todos.get --input-json "{\"id\":\"$TASK_ID\"}"
```

The following requests exit nonzero with `ResourceNotFound`: Bob is in the same tenant but is not the owner, and the outsider has Alice's user ID but belongs to a different tenant. Reads hide rows outside the policy's visibility rather than revealing that a protected row exists.

```bash
TEAM_TASKS_TOKEN="$(login_token bob)" bun run team-tasks todos.get --input-json "{\"id\":\"$TASK_ID\"}"
TEAM_TASKS_TOKEN="$(login_token outsider)" bun run team-tasks todos.get --input-json "{\"id\":\"$TASK_ID\"}"
```

A missing or unknown credential instead fails authentication with `Unauthenticated` before a policy is evaluated:

```bash
TEAM_TASKS_TOKEN=not-a-session bun run team-tasks todos.get --input-json "{\"id\":\"$TASK_ID\"}"
```

Finally, show the change rule. Alice may complete her incomplete task, but may not edit it afterward:

```bash
bun run team-tasks todos.patch --input-json "{\"key\":\"$TASK_ID\",\"changes\":{\"completed\":true}}"
bun run team-tasks todos.patch --input-json "{\"key\":\"$TASK_ID\",\"changes\":{\"detail\":\"Late calibration note\"}}"
```

The second request exits nonzero with `Forbidden`, and the completed row remains unchanged. An administrator may reopen it, but may not transfer its tenant or owner. See the complete [team-tasks walkthrough](../../examples/team-tasks/README.md).

## Declare row scope, action rules, and trusted creation values

The task resource defines its policy with the resource schema and the authenticated-subject schema. That gives `row`, `next`, and `subject` fields their TypeScript types and restricts comparisons to compatible scalar values.

```ts
import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ExampleSubjectSchema } from "@effect-domains/example-support/subject"
import { TaskSchema } from "./domain.ts"

const p = Authorization.for({ resource: TaskSchema, subject: ExampleSubjectSchema })
const scope = p.eq(p.row.tenantId, p.subject.tenantId)
const owned = p.eq(p.row.ownerId, p.subject.userId)
const administrator = p.includes(p.subject.roles, "admin")
const ownerOrAdministrator = p.any(owned, administrator)
const candidateOwner = p.eq(p.next.ownerId, p.subject.userId)
const unchangedOwnership = p.unchanged("tenantId", "ownerId")
const incomplete = p.eq(p.row.completed, false)
const editable = p.any(administrator, p.all(owned, incomplete))
const protectedEdit = p.all(unchangedOwnership, editable)

const authorization = p.policy({
  scope,
  allow: {
    read: ownerOrAdministrator,
    create: candidateOwner,
    update: protectedEdit,
    patch: protectedEdit,
    remove: administrator,
  },
})

export const TasksResource = Resource.make({
  authorization,
  name: "todos",
  schema: TaskSchema,
  operations: {
    ...Resource.crud,
    patch: true,
    create: {
      defaults: { completed: false, detail: null, dueDate: null, priority: "normal" },
      fromSubject: { tenantId: p.subject.tenantId, ownerId: p.subject.userId },
    },
    list: { filter: ["project", "priority", "completed"], limit: 25 },
  },
})
```

`scope` constrains every row-bearing action to the subject's tenant. `read` determines visibility; `create` sees the candidate `next` row; `update` and `patch` can compare both the stored row and candidate. `fromSubject` is a trusted server-side binding: generated create input does not accept `tenantId` or `ownerId`, and the resource validates that each binding is a compatible subject-field reference. It is not a permission grant; the `create` rule still authorizes the candidate row.

The server must provide authenticated claims to the runtime. This example installs its identity runtime as an application service:

```ts
pipe(ApplicationBun.run(TeamTasksApplication, {
  database: { migrations: TeamTasksMigrations },
  services: ExampleIdentity,
  admin: true,
}), BunRuntime.runMain)
```

`ExampleIdentity` supplies the example credential store and the generic `AuthorizationRpc.Authenticator`. The authenticator's contract remains only the verified `{ userId, tenantId, roles }` subject used by this resource; it is not an opaque-session facade. The application separately composes the native `IdentityRpcs` group and `IdentityHandlers`, so `identity.login`, `identity.current`, and `identity.logout` verify credentials or credentials-on-every-call at that boundary. Do not trust identity or tenant fields supplied in an RPC payload. See the [identity service](../../packages/example-support/src/identity.ts), [identity RPC group](../../packages/effect-domains/src/identity-rpc.ts), and [team-task resource](../../examples/team-tasks/resources.ts).

## Deny an action by leaving it out

An `allow` record is a closed permission list. An action with no `allow` rule is denied, even if the resource publishes that generated operation. For a resource that must retain all task records, omit `remove` while retaining the other task rules:

```ts
const retentionAuthorization = p.policy({
  scope,
  allow: {
    read: ownerOrAdministrator,
    create: candidateOwner,
    update: protectedEdit,
    patch: protectedEdit,
  },
})
```

Assign `retentionAuthorization` to the resource’s `authorization` option. With `remove: true` still published, removing a visible task fails with `Forbidden`. Prefer omitting the operation from `operations` as well when clients should not discover it; omitting the action rule is the policy-level backstop.

## Keep authorization separate from entitlement gating

Use this policy for identity, tenant visibility, ownership, and role decisions that are evaluated from the authenticated subject and resource row. Use an entitlement requirement only when an already-authorized action additionally needs an application-owned, current grant such as a purchase or subscription.

The purchased-guides example first permits a tenant reader/editor/admin, then requires the `guides.read` grant keyed by the guide row ID:

```ts
const guidePurchase = policy.entitlement({ name: "guides.read", key: policy.row.id })

const guideAuthorization = policy.policy({
  scope: tenantScope,
  allow: { read: guideReader },
  require: { read: [guidePurchase] },
})
```

An entitlement does not replace tenant scope or role policy, and it does not derive a grant from a schema field. Its resolver is application-provided and can report `EntitlementRequired` or `EntitlementUnavailable`; it is not an authentication mechanism. See the [entitlement resource](../../examples/purchased-guides/resources.ts) and [Authorization API](../../packages/effect-domains/src/authorization.ts).
