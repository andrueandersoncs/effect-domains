---
description: Bun runner options, environment variables, generated commands, HTTP endpoints, and client input formats.
---

# Runtime and clients

This reference covers `ApplicationBun.run` in the current Bun workspace. The [first-run tutorial](/getting-started) shows a complete invocation; [define a resource](/guides/define-a-resource) covers application setup.

## Application composition

```ts
import { Application } from "effect-domains/application"
import { ReadingListResource } from "./resources.ts"

const application = Application.make({
  name: "reading-list",
  parts: [ReadingListResource],
})
```

This example belongs beside the reading list's `resources.ts`. In your application, import the resource you want to register.

`parts` accepts resources, native `{ group, handlers }` RPC bundles, and nested applications. Construction rejects duplicate resource table names and duplicate RPC operation names. Nesting composes parts; it does not supply an automatic naming prefix.

## Bun runner

Import `ApplicationBun` from `effect-domains/application-bun`. Pass its returned Effect to `BunRuntime.runMain` from `@effect/platform-bun`.

| Option | Contract |
| --- | --- |
| `database.migrations` | Required ordered array of decoded SQLite migration artifacts, usually from `SqliteMigrations.decodeHistory`. |
| `database.filename` | Optional explicit filename; overrides the database environment variable. |
| `services` | Application service layer, built with the application SQL client available. Authentication and storage-codec services belong here. |
| `initialize` | Startup Effect, run after database preparation and service construction. |
| `background` | Background layer, built after initialization. Also enables the `worker` command. |
| `routes` | Additional native HTTP route layer for `serve`. |
| `admin` | Omitted by default. `true` enables the prebuilt admin; an object accepts `path`, `presentation`, and `allowedOrigins`. |

For `serve` and `worker`, startup prepares the database, builds `services`, runs `initialize`, and then starts `background`. `serve` additionally starts HTTP. Initialization therefore also runs in worker mode; it must be appropriate for each process you launch.

## Environment variables

The prefix comes from `application.name`: uppercase, with each non-alphanumeric character replaced by `_`. For `reading-list`, the prefix is `READING_LIST`.

| Variable | Used by | Default |
| --- | --- | --- |
| `PORT` | Server | `3000` |
| `<PREFIX>_DB` | Server / worker, unless `database.filename` is set | `<application-name>.sqlite` in the working directory |
| `<PREFIX>_URL` | Remote CLI | `http://127.0.0.1:3000/rpc/v1` |
| `<PREFIX>_TOKEN` | Remote CLI | Absent; when set, sent as a bearer token |

`PORT` does **not** change the client URL. Example, in separate terminals:

```bash
# Server
PORT=3001 READING_LIST_DB=reading-list-local.sqlite bun run reading-list:server
```

```bash
# Client
READING_LIST_URL=http://127.0.0.1:3001/rpc/v1 bun run reading-list books.list
```

The Bun runner binds to `127.0.0.1`. It does not provide a configurable public bind address or a production deployment setup.

## Local commands

| Command | Behavior |
| --- | --- |
| `--help` | Lists commands. An operation’s `--help` describes its CLI usage. |
| `serve` | Starts HTTP RPC, MCP, and any configured admin/routes. |
| `inspect` | Prints application contracts and metadata as JSON. |
| `inspect <operation>` | Restricts inspection to one operation. |
| `worker` | Runs the application runtime without HTTP. Available only when `background` is configured. |

Help and inspection do not need a running server. Inspection does not execute handlers or prove that a database matches the declared schema.

## Remote CLI operations

```bash
bun run reading-list books.create --input-json '{"title":"A Wizard of Earthsea","author":"Ursula K. Le Guin","status":"planned","format":"paperback"}'
```

- Input is a single canonical JSON value through `--input-json`, not one flag per field.
- Use JSON numbers and booleans, not quoted substitutes.
- An empty struct or an all-optional object payload defaults to `{}` when input is omitted. No-payload operations also need no input.
- Required payload fields must be supplied. Creation defaults are specific to that operation.
- Success is JSON on stdout. Input, transport, authorization, and declared operation failures exit nonzero.
- Input and result codecs follow the RPC contract, not storage encodings. Encrypted storage values do not belong in CLI input.

## HTTP endpoints

| Path | Protocol | Availability |
| --- | --- | --- |
| `/rpc/v1` | Effect HTTP RPC with JSON serialization | Every `serve` command |
| `/mcp` | Streamable HTTP MCP | Every `serve` command |
| `/admin` | Browser administration | Only when enabled; path is configurable |

`/rpc/v1` is not a REST resource API. Use the generated CLI or native Effect `RpcClient`.

### MCP tools

Each published RPC operation becomes a tool. Arguments wrap the canonical payload:

```json
{
  "input": {
    "filter": { "status": "planned" },
    "limit": 10
  }
}
```

Successful structured content is `{ "result": <operation result> }`, also returned as JSON text; void results become `null`. Declared failures return `isError: true` with the encoded error.

Protected tools require bearer credentials on every call. Tool discovery exposes contracts, not authorization to read protected rows. The [equipment example](/examples#equipment-register) includes an SDK client.

### Browser admin

Run `bun run build` before starting an admin-enabled server. Runtime loads prebuilt JavaScript and CSS; it does not compile the browser application on startup.

The interface provides operation forms, resource lists, declared filters, cursor paging, and a full-JSON input fallback. It uses the same handlers and authorization as other clients. Tokens entered in the UI remain in browser memory.

`allowedOrigins` names exact origins permitted by the admin’s origin check when using a non-loopback host. It is not a CORS configuration, authentication policy, or permission grant.

## Durable execution

The runner composes native Effect layers; it does not supply its own job system. The report and reminder examples use native SingleRunner with a separate execution database. Run **either** their server **or** worker against one execution store, not both concurrently. See [durable examples](/examples#durable-work) for the application-specific setup and limits.

## Sources

- [Bun runtime](../../packages/effect-domains/src/application-bun.ts)
- [Application composition](../../packages/effect-domains/src/application.ts)
- [CLI adapter](../../packages/effect-domains/src/rpc-cli.ts)
- [MCP adapter](../../packages/effect-domains/src/rpc-mcp.ts)
- [Admin adapter](../../packages/effect-domains/src/application-admin.ts)
