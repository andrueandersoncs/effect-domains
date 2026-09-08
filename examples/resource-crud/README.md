# Resource CRUD: generated todo operations

This is the smallest complete application that accepts the framework's generated CRUD contract. A todo resource supplies its canonical shape and selects the five standard operations; the application needs no authored command service or SQL implementation.

## What is generated and what is authored

[`domain.ts`](domain.ts) authors the canonical todo: a non-empty `title` and a boolean `completed` flag. [`resources.ts`](resources.ts) supplies that schema to `Resource.make` and selects `get`, `list`, `create`, `update`, and `remove`.

From that declaration, the framework derives the `todos` table, a UUIDv7 `id` added by persistence, row and wire schemas, repository, five RPC procedures, and their handler layer. [`application.ts`](application.ts) omits custom commands and publishes the resource's generated handlers directly. There is no empty RPC group, resource-specific service wrapper, or SQLite query file.

This is the right boundary when the standard semantics suffice: `create` accepts the canonical todo, `get` and `remove` take its generated id, and `update` takes the complete stored row. Generated `remove` succeeds with `void`; missing rows and repository/schema failures use the generated `ResourceNotFound` and `RepositoryError` contract. For a version that owns SQL, result shape, and errors instead, see [basic-crud](../basic-crud/).

## Run it

Run commands from the repository root. Start the server in one terminal:

```bash
bun run resource-crud:server
```

Then create and list todos from another terminal:

```bash
bun run resource-crud todos.create --title "Ship applications" --completed false
bun run resource-crud todos.list
```

Copy the returned identifier into `TODO_ID`, then read, update, and remove that complete row:

```bash
bun run resource-crud todos.get --id "$TODO_ID"
bun run resource-crud todos.update --id "$TODO_ID" --title "Ship applications" --completed true
bun run resource-crud todos.remove --id "$TODO_ID"
```

The canonical todo has no `id`; persistence generates the UUIDv7 key, and update requires it together with both stored fields. `title` must be non-empty.

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

Startup applies the checked-in, frozen migration chain and preserves existing rows; it does not reset the database. An untracked database is rejected rather than silently adopted. The generated repository supplies simple row CRUD only: there is no application-specific policy, pagination, or ordering contract. Missing `get`, `update`, or `remove` calls fail through the generated resource error contract.

Schema commands run locally, without a server:

```bash
bun run resource-crud schema snapshot --out current-schema.json
bun run resource-crud schema plan --id 002_change \
  --from examples/resource-crud/migrations/001_initial.json \
  --out 002_change.json
```

Review a planned artifact before adding it to [`migrations.ts`](migrations.ts). Do not regenerate migration artifacts that have already been applied.

## Code map

- [`domain.ts`](domain.ts): canonical todo fields.
- [`resources.ts`](resources.ts): the `Resource.make` declaration and all five selected generated operations.
- [`application.ts`](application.ts): application registration with no authored commands.
- [`migrations.ts`](migrations.ts) and [`migrations/001_initial.json`](migrations/001_initial.json): decoded frozen schema history.
- [`server.ts`](server.ts) and [`cli.ts`](cli.ts): SQLite runtime, generated RPC handlers, client, and local schema commands.

See the [examples overview](../README.md), [authored book CRUD](../basic-crud/), and [service-dependent storage codec](../service-codec/).
