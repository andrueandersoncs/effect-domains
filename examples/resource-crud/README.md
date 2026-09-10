# Resource CRUD: tenant-owned todo operations

This generated CRUD application demonstrates resource authorization with actual todo ownership data. A stored todo has a non-empty `title`, a `completed` flag, and required `tenantId` and `ownerId` strings. `Resource.make` supplies generated storage, repository, RPC procedures, and handlers; no todo-specific command service or SQL implementation is authored.

## Authorization policy

[`resources.ts`](resources.ts) declares a typed policy over the todo and the authenticated demo subject:

```ts
import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ExampleSubjectSchema } from "@effect-domains/example-support/authentication"
import { TodoSchema } from "./domain.ts"

const p = Authorization.for({ resource: TodoSchema, subject: ExampleSubjectSchema })
const scope = p.eq(p.row.tenantId, p.subject.tenantId)
const owned = p.eq(p.row.ownerId, p.subject.userId)
const administrator = p.includes(p.subject.roles, "admin")
const ownerOrAdministrator = p.any(owned, administrator)
const candidateOwner = p.eq(p.next.ownerId, p.subject.userId)
const unchangedOwnership = p.unchanged("tenantId", "ownerId")
const incomplete = p.eq(p.row.completed, false)
const incompleteOwned = p.all(owned, incomplete)
const editable = p.any(administrator, incompleteOwned)
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

const TodosResource = Resource.make({
  authorization,
  name: "todos",
  schema: TodoSchema,
  operations: {
    ...Resource.crud,
    patch: true,
    create: {
      defaults: { completed: false },
      fromSubject: { tenantId: p.subject.tenantId, ownerId: p.subject.userId },
    },
    list: {
      filter: ["completed"],
      limit: 25,
    },
  },
})
```

Every operation is tenant-scoped. Within a tenant, an owner can read a todo; an administrator can read every todo. Creation derives the caller's tenant and owner from the typed subject bindings. Owners may update or patch only incomplete todos and cannot change either ownership field. Administrators can update, reopen, and delete tenant todos, but cannot transfer ownership because `tenantId` and `ownerId` must remain unchanged. Omitted actions deny access.

`completed` is optional on create and defaults to `false` when absent; an explicit value wins. `id`, `tenantId`, and `ownerId` are absent from create input: the identifier is generated, and the ownership values come from the authenticated subject. The server rejects an attempted `tenantId` or `ownerId` create value before policy evaluation. `get` and `remove` take `id`, `update` takes the complete stored row, and `patch` takes `{ key, changes }`. `patch` may include any non-id todo field, validates the complete candidate row after merging, and commits atomically. Hidden rows behave as missing rather than disclosing their existence.

## Run with the demo credentials

Run commands from the repository root. Start the loopback server:

```bash
bun run resource-crud:server
```

The same runner opts into the generated admin at [http://127.0.0.1:3000/admin](http://127.0.0.1:3000/admin). Enter one of the demo bearer tokens there to make the same policy-protected calls; see the [shared admin guide](../README.md#generated-admin).

The generated CLI reads `RESOURCE_CRUD_TOKEN` and sends it as a bearer token. The following deliberately public demo fixtures are only for this loopback example:

| Token | Subject | Useful behavior |
| --- | --- | --- |
| `alice-demo` | `alice` in `acme`, `editor` | Creates and reads Alice-owned todos; edits them while incomplete. |
| `bob-demo` | `bob` in `acme`, `reader` | Creates and reads Bob-owned todos only. |
| `admin-demo` | `admin` in `acme`, `admin` | Reads, reopens, updates, and deletes every Acme todo. |
| `outsider-demo` | `alice` in `other`, `editor` | Cannot see any Acme todo, even one owned by `alice`. |

Create an Alice-owned todo without supplying ownership:

```bash
export RESOURCE_CRUD_TOKEN=alice-demo
bun run resource-crud todos.create --input-json '{"title":"Ship applications"}'
bun run resource-crud todos.list --input-json '{"filter":{"completed":false},"limit":10}'
```

The list policy accepts only `filter.completed`, `limit`, and an opaque `cursor`. It applies authorization before filtering and pagination, orders by generated identifier ascending only, and returns `{ "items": [...], "nextCursor": string | null }`. Pass a non-null cursor back unchanged with the same filter to fetch the next page. `limit` is from 1 through 25.

Switching to Bob hides Alice's todo; switching to the outsider hides all Acme data:

```bash
RESOURCE_CRUD_TOKEN=bob-demo bun run resource-crud todos.list --input-json '{"limit":10}'
RESOURCE_CRUD_TOKEN=outsider-demo bun run resource-crud todos.list --input-json '{"limit":10}'
```

Set `TODO_ID` to the identifier returned by Alice's create command. Alice can patch or fully update her incomplete todo, but cannot transfer it:

```bash
export RESOURCE_CRUD_TOKEN=alice-demo
bun run resource-crud todos.get --input-json "{\"id\":\"$TODO_ID\"}"
bun run resource-crud todos.patch --input-json "{\"key\":\"$TODO_ID\",\"changes\":{\"title\":\"Ship released applications\"}}"
bun run resource-crud todos.patch --input-json "{\"key\":\"$TODO_ID\",\"changes\":{\"ownerId\":\"bob\"}}"
```

The last command exits nonzero with `Forbidden`: ownership fields are immutable even while the todo is incomplete. Alice can complete the todo, but cannot edit or reopen it afterward:

```bash
bun run resource-crud todos.update --input-json "{\"id\":\"$TODO_ID\",\"title\":\"Ship released applications\",\"completed\":true,\"tenantId\":\"acme\",\"ownerId\":\"alice\"}"
bun run resource-crud todos.patch --input-json "{\"key\":\"$TODO_ID\",\"changes\":{\"title\":\"Blocked edit\"}}"
```

The last command fails with `Forbidden` and leaves the completed todo unchanged. An Acme administrator can reopen it and delete it:

```bash
RESOURCE_CRUD_TOKEN=admin-demo bun run resource-crud todos.update --input-json "{\"id\":\"$TODO_ID\",\"title\":\"Ship released applications\",\"completed\":false,\"tenantId\":\"acme\",\"ownerId\":\"alice\"}"
RESOURCE_CRUD_TOKEN=admin-demo bun run resource-crud todos.remove --input-json "{\"id\":\"$TODO_ID\"}"
```

`patch` accepts `{ key, changes }` and need not repeat unchanged fields; `update` requires the complete row. `title` must be non-empty. Use `--input-json` for the complete canonical request shape, including nested `changes` and `filter` objects. Generated field flags are not supported.

## Runtime and persistence

| Setting | Default | Meaning |
| --- | --- | --- |
| `RESOURCE_CRUD_DB` | `resource-crud.sqlite` | SQLite database file used by the server |
| `PORT` | `3000` | Loopback HTTP port |
| `RESOURCE_CRUD_URL` | `http://127.0.0.1:3000/rpc/v1` | RPC endpoint used by the CLI |
| `RESOURCE_CRUD_TOKEN` | unset | Demo bearer token sent by the CLI |

The server is loopback-only and speaks Effect's JSON RPC protocol rather than REST. To run beside another example, change both the server port and this CLI endpoint:

```bash
PORT=3001 RESOURCE_CRUD_DB=todos.sqlite bun run resource-crud:server
RESOURCE_CRUD_URL=http://127.0.0.1:3001/rpc/v1 RESOURCE_CRUD_TOKEN=alice-demo bun run resource-crud todos.list
```

The credentials are hard-coded public fixtures, not production authentication: they have no password verification, rotation, expiry, transport security, or token issuance. They demonstrate that `AuthorizationRpc.Authenticator` produces trusted request-local claims. Do not reuse them outside a local demo. Other examples remain public unless they declare authorization policy.

Startup applies the checked-in, frozen migration chain and preserves existing rows; it does not reset the database. Migration `002_ownership` adds the ownership columns and backfills existing todos with `tenantId = "acme"` and `ownerId = "alice"`. An untracked database is rejected rather than silently adopted.

[`003_schema_string_checks`](migrations/003_schema_string_checks.json) preserves the rows while removing the old SQLite title-length constraint. Canonical non-empty validation remains authoritative because JavaScript and SQLite string lengths are not equivalent.

List order is always identifier ascending. There is no arbitrary order declaration, separate repository `page` method, or unbounded generated list. This resource sets its page limit to 25; resources without list configuration default to 50.

Inspection runs locally without a server or token:

```bash
bun run resource-crud inspect todos.patch
```

`inspect` describes the selected operation and the resource's schemas, storage, creation/list configuration, subject schema, and rendered authorization policy. There is no schema CLI. [Author explicit migration steps](../README.md#review-schema-changes) and append reviewed artifact imports to the ordered history in [`migrations.ts`](migrations.ts). Do not regenerate migration artifacts that have already been applied.

## Code map

- [`domain.ts`](domain.ts): canonical todo and ownership fields.
- [`resources.ts`](resources.ts): authorization policy, defaults, page/list policy, and selected generated operations.
- [`application.ts`](application.ts): application registration with no authored commands.
- [`migrations.ts`](migrations.ts) and [frozen artifacts](migrations/): ordered imports and decoded runtime history.
- [`main.ts`](main.ts): the server, generated CLI, and inspection runner with demo authentication.

See the [examples overview](../README.md), [authored book CRUD](../README.md#authored-sql), and [service-dependent storage codec](../service-codec/).
