# Restrict access to tenant-owned records

Use this guide when rows belong to tenants and owners, while a tenant administrator can manage the tenant's rows. It uses `team-tasks` and its issued-session demonstration identity.

## Start an isolated demonstration

From the repository root:

```bash
bun install
bun run build
DEMO_DIR="$(mktemp -d)"
export EFFECT_DOMAINS_DEMO_PASSWORD='correct-horse-battery-staple'
PORT=3001 \
  TEAM_TASKS_DB="$DEMO_DIR/team-tasks.sqlite" \
  TEAM_TASKS_IDENTITY_DB="$DEMO_DIR/team-tasks-identity.sqlite" \
  bun run team-tasks:server
```

The identity database must differ from the application database. `SqliteIdentity.layer` derives `TEAM_TASKS_IDENTITY_DB` from the application name; it does not use a shared identity environment variable.

In another terminal, obtain Alice's token and create a task:

```bash
export TEAM_TASKS_URL=http://127.0.0.1:3001/rpc/v1
export TEAM_TASKS_TOKEN="$(
  bun run team-tasks identity.login --input-json "$(
    bun -e 'console.log(JSON.stringify({ username: "alice", password: process.env.EFFECT_DOMAINS_DEMO_PASSWORD }))'
  )" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).token)'
)"
bun run team-tasks todos.create --input-json '{"project":"North Yard pump inspection","title":"Attach pressure-test photo","detail":"Use the calibrated gauge record.","priority":"high","dueDate":"2026-09-18"}'
```

The returned task has trusted `tenantId: "acme"` and `ownerId: "alice"`; neither appears in the request. Bob cannot read Alice's task, even in the same tenant, and a missing or invalid token fails with `Unauthenticated` before policy evaluation.

## Declare scope and action rules

`Authorization.for` type-checks row, candidate (`next`), and subject operands. `sameAs(field)` is the concise tenant equality declaration for matching resource and subject fields.

```ts
import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ExampleRoles, ExampleSubjectSchema } from "@effect-domains/example-support/subject"
import { TaskSchema } from "./domain.ts"

const p = Authorization.for({ resource: TaskSchema, subject: ExampleSubjectSchema })
const scope = p.sameAs("tenantId")
const owned = p.eq(p.row.ownerId, p.subject.userId)
const candidateOwner = p.eq(p.next.ownerId, p.subject.userId)
const incomplete = p.eq(p.row.completed, false)
const unchangedOwnership = p.unchanged("tenantId", "ownerId")
const editable = p.any(ExampleRoles.admin.expression, p.all(owned, incomplete))

const authorization = p.policy({
  scope,
  allow: {
    read: p.any(owned, ExampleRoles.admin.expression),
    create: candidateOwner,
    update: p.all(unchangedOwnership, editable),
    patch: p.all(unchangedOwnership, editable),
    remove: ExampleRoles.admin,
  },
})

export const TasksResource = Resource.define({
  name: "todos",
  schema: TaskSchema,
  authorization,
  capabilities: Resource.capabilities(
    Resource.get(),
    Resource.list({ filter: ["project", "priority", "completed"], limit: 25 }),
    Resource.create({
      sources: {
        completed: Resource.defaultValue(false),
        priority: Resource.defaultValue("normal"),
        tenantId: Resource.fromSubject(p.subject.tenantId),
        ownerId: Resource.fromSubject(p.subject.userId),
      },
    }),
    Resource.update(),
    Resource.remove(),
    Resource.patch(),
  ),
})
```

`Authorization.subject(ExampleSubjectSchema).policy(...)` creates a reusable `SubjectPolicy`. Pass that policy directly as `scope` or any `allow` action; its expression and entitlement requirements are embedded in the resource policy. Reuse those policies in authored command families with `.authorized(policy)` too.

`includes` is literal-typed: `p.includes(p.subject.roles, "admin")` is valid only when the subject role schema declares the literal `"admin"`. This makes misspelled or undeclared role names fail at compile time.

`scope` constrains every row-bearing action. `read` determines visibility; `create` receives the candidate `next` row; `update` and `patch` can compare stored and candidate rows. `fromSubject` is a trusted binding, not a permission grant: the `create` rule still authorizes the candidate.

## Keep entitlements separate

Use policy expressions for identity, tenant visibility, ownership, and roles. Use an entitlement when an already-authorized action also needs a current persisted grant.

```ts
import { Entitlements } from "effect-domains/entitlements"
import { ExampleSubjectSchema } from "@effect-domains/example-support/subject"
import { Resource } from "effect-domains/resource"
import { GuidePurchasesResource } from "./resources.ts"

const purchases = Resource.table(GuidePurchasesResource)
const grants = Entitlements.for(purchases)

const purchasedGuideEntitlement = new Entitlements.Source({
  name: "guides.read",
  table: purchases,
  subject: ExampleSubjectSchema,
  key: "guideId",
  scope: { tenantId: "tenantId", userId: "userId" },
  grant: grants.eq(grants.row.status, "granted"),
})

export const PurchasedGuideEntitlements = Entitlements.fromTable(purchasedGuideEntitlement)
```

Use `Entitlements.fromTables([...])` for multiple names. Each source declares `scope` as storage-field-to-subject-field bindings; the type system rejects missing, optional, or scalar-incompatible subject fields. `Entitlements.for(table)` supplies typed row operands, `now`, equality and ordering comparisons, and `all`/`any` composition. `grant` is a closed `Entitlements.GrantSchema` expression, so status, expiration, and cancellation-grace decisions remain explicit and inspectable without an executable callback. The resolver finds the requested `key` under the declared bindings, decodes the row, and evaluates that expression. A missing grant yields `EntitlementRequired`; database or decoding failure yields `EntitlementUnavailable`. Neither one replaces resource scope or authentication.

See the [team-task resource](../../examples/team-tasks/resources.ts), [purchased-guide entitlement](../../examples/purchased-guides/entitlements.ts), and [`Authorization`](../../packages/effect-domains/src/authorization.ts).
