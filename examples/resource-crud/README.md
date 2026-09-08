# Resource CRUD: generated todo operations

This is the smallest complete application that accepts the framework's generated CRUD contract. A todo resource supplies its canonical shape, creation and list policies, and `Resource.crud` plus `patch`; the application needs no authored command service or SQL implementation.

## What is generated and what is authored

[`Resource.make`](../../src/resource.ts) accepts `{ name, schema, storage?, operations, create?, list? }`. [`domain.ts`](domain.ts) authors the canonical todo: a non-empty `title` and a boolean `completed` flag. [`resources.ts`](resources.ts) supplies that schema, declares `create.defaults.completed: false`, a filtered/paginated list policy, and `operations: [...Resource.crud, "patch"]`. `Resource.crud` is `get`, `list`, `create`, `update`, and `remove`; `patch` is selected explicitly. A creation policy can also mark fields as generated with the runtime `Value` service tokens `"uuidV7"` or `"now"`.

From that declaration, the framework derives the `todos` table, a UUIDv7 `id` added by persistence, canonical row and wire schemas, repository, six RPC procedures, and their handler layer. [`application.ts`](application.ts) omits custom commands and publishes the resource's generated handlers directly. There is no empty RPC group, resource-specific service wrapper, or SQLite query file.

On create, `completed` is optional and defaults to `false` only when it is absent; an explicit value wins. `id` is generated and create input must not provide it. `get` and `remove` take that id, `update` takes the complete stored row, and `patch` takes `{ id, patch }`: `patch` may include any non-id todo field, keeps the id immutable, validates the completed candidate row, and commits it atomically. Generated `remove` succeeds with `void`; missing rows and repository/schema failures use `ResourceNotFound` and `RepositoryError`. For a version that owns SQL, result shape, and errors instead, see [basic-crud](../basic-crud/).

## Run it

Run commands from the repository root. Start the server in one terminal:

```bash
bun run resource-crud:server
```

Then create and page through todos from another terminal:

```bash
bun run resource-crud todos.create --title "Ship applications"
bun run resource-crud todos.list --filter-completed false --limit 10
```

The declared list policy accepts only `filter.completed`, `limit`, and an opaque `cursor`. It orders by physical scalar `title` ascending, with the generated id as the deterministic tie-breaker. A response is `{ "items": [...], "nextCursor": string | null }`; pass a non-null cursor back unchanged with the same filter to fetch the next page. `limit` is from 1 through 25 (the policy maximum).

Copy the returned identifier into `TODO_ID`, then read, patch, fully update, and remove the row:

```bash
bun run resource-crud todos.get --id "$TODO_ID"
bun run resource-crud todos.patch --id "$TODO_ID" --patch-title "Ship applications"
bun run resource-crud todos.update --id "$TODO_ID" --title "Ship applications" --completed true
bun run resource-crud todos.remove --id "$TODO_ID"
```

`patch` need not repeat unchanged fields; `update` does. `title` must be non-empty. Native nested flags include `--filter-completed` and `--patch-title`; `--input-json` remains available for the complete request shape.

## Runtime and persistence

| Setting | Default | Meaning |
| --- | --- | --- |
| `RESOURCE_CRUD_DB` | `resource-crud.sqlite` | SQLite database file used by the server |
| `PORT` | `3000` | Loopback HTTP port |
| `RESOURCE_CRUD_URL` | `http://127.0.0.1:3000/rpc/v1` | RPC endpoint used by the CLI |

The server is loopback-only and speaks Effect's JSON RPC protocol rather than REST. Use the generated CLI or an Effect `RpcClient`; no authentication is provided. To run beside another example, change both the server port and this CLI endpoint:

```bash
PORT=3001 RESOURCE_CRUD_DB=todos.sqlite bun run resource-crud:server
RESOURCE_CRUD_URL=http://127.0.0.1:3001/rpc/v1 bun run resource-crud todos.list
```

Startup applies the checked-in, frozen migration chain and preserves existing rows; it does not reset the database. An untracked database is rejected rather than silently adopted.

List ordering is deliberately restricted to declared, non-nullable fields with the same canonical and storage schema and a supported physical scalar representation (`string`, `integer`, or `number`). This resource orders by its physical string `title`. Custom codecs whose storage differs from their canonical field and nullable fields cannot be declared as list-order fields; arbitrary codec ordering is not inferred.

Schema commands run locally, without a server. After changing a resource schema, generate against the manifest at [`migrations/manifest.json`](migrations/manifest.json), the runtime registry:

```bash
bun run resource-crud schema generate add-field
bun run resource-crud inspect todos.patch
```

`generate` writes the next valid artifact and atomically registers it in the manifest. `inspect` describes the selected operation and the resource's schemas, storage, creation, and list policy. Do not regenerate migration artifacts that have already been applied.

## Code map

- [`domain.ts`](domain.ts): canonical todo fields.
- [`resources.ts`](resources.ts): the `Resource.make` declaration, defaults, page/list policy, and selected generated operations.
- [`application.ts`](application.ts): application registration with no authored commands.
- [`migrations/manifest.json`](migrations/manifest.json) and [frozen artifacts](migrations/): the runtime migration registry and history.
- [`main.ts`](main.ts): the sole server, generated CLI, schema-command, and inspection runner.

See the [examples overview](../README.md), [authored book CRUD](../README.md#authored-sql), and [service-dependent storage codec](../service-codec/).
