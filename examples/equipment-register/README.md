# Equipment register

[All examples](../README.md)

Register a field camera, discover its generated MCP tools with the official Model Context Protocol SDK, move it, retire it, and remove it. The workflow shows the difference between an editable human asset tag and the generated UUIDv7 that identifies the record for `get`, `update`, and `remove`.

## Before you start

Run these commands from the repository root with Bun:

```bash
bun install
bun run build
```

Although this application does **not** enable the generated `/admin` interface, `bun run build` is still required before `serve`. Its public Foldkit register at `/` reads prebuilt `web/dist` assets. The application is public loopback-only, so its CLI and MCP client need no bearer token.

Use a new SQLite filename for this walkthrough. The SDK walkthrough creates the fixed tag `EQ-CAM2048`; an interrupted run can leave that row behind, and a second create with the same tag is rejected.

```bash
export EQUIPMENT_REGISTER_DB="$(mktemp -d)/equipment-register.sqlite"
bun run equipment-register:server
```

Keep this first terminal running. The server listens on `http://127.0.0.1:3000`, exposes the RPC endpoint at `/rpc/v1`, the Streamable HTTP MCP endpoint at `/mcp`, and the Foldkit application at `/`. There is no `/admin` route for this example.

Use another terminal for clients. Alternatively, to run beside another server, use the following **instead of** the server command above (stop an already-running instance first), then configure both client URLs:

```bash
PORT=3001 bun run equipment-register:server
# In the separate client terminal:
export EQUIPMENT_REGISTER_URL=http://127.0.0.1:3001/rpc/v1
export EQUIPMENT_REGISTER_MCP_URL=http://127.0.0.1:3001/mcp
```

Without overrides, the database is `equipment-register.sqlite`, the CLI URL is `http://127.0.0.1:3000/rpc/v1`, and the MCP client URL is `http://127.0.0.1:3000/mcp`. Reusing the same database across restarts preserves its rows and verifies its frozen imported migration history; choose a new database path for a clean repeat.

## Run it with the MCP SDK

In the client terminal, run the checked-in walkthrough:

```bash
bun run equipment-register:client
```

It uses `@modelcontextprotocol/sdk`'s `Client` and `StreamableHTTPClientTransport`, then follows this lifecycle:

1. creates the client inside an Effect acquire/release scope and connects it to `EQUIPMENT_REGISTER_MCP_URL`;
2. prints the connected server version and calls `tools/list`, so you can inspect discovered generated tool contracts;
3. calls `assets.create` for `EQ-CAM2048`, decodes the returned row, and calls `assets.get` with its generated `id`;
4. updates the same complete row to `location: "Editorial desk"`, lists the matching in-service equipment, changes it to `retired`, and removes it;
5. calls `assets.get` after removal and requires the MCP failure text to contain `ResourceNotFound`;
6. terminates the transport session; scope release closes the SDK client.

Every MCP tool receives one argument object with the RPC payload under `input`. A successful tool response has `isError: false` and both JSON text content and `structuredContent`, whose useful value is `{ "result": <RPC result> }`. The walkthrough decodes that `structuredContent.result` rather than assuming a REST-shaped response. Declared RPC failures use `isError: true` with encoded error text; malformed tool arguments are rejected as invalid parameters.

The client removes only the row it created. If it exits before removal, keep the record and use the CLI section below to inspect or remove it, or start again with a fresh `EQUIPMENT_REGISTER_DB` path.

## Run the equivalent workflow with the CLI

Use a distinct tag so this manual flow does not collide with the SDK's fixed camera. The create result is a complete row with an `id`; copy it into the assignment by replacing the placeholder.

```bash
bun run equipment-register assets.create --input-json '{"assetTag":"EQ-CAM2049","name":"Field camera","model":"X100V","serial":"FJ2-2025-0043","location":"Studio A","condition":"in-service"}'
export ASSET_ID='paste-the-returned-id-here'
```

List that current location and condition. Generated list results are objects containing `items` and `nextCursor`.

```bash
bun run equipment-register assets.list --input-json '{"filter":{"location":"Studio A","condition":"in-service"}}'
```

Now read and replace the complete UUID-keyed record. The change to `assetTag` is intentional: the tag is unique but editable; the stable `id` still selects the record.

```bash
bun run equipment-register assets.get --input-json "{\"id\":\"$ASSET_ID\"}"
bun run equipment-register assets.update --input-json "{\"id\":\"$ASSET_ID\",\"assetTag\":\"EQ-CAM2050\",\"name\":\"Field camera\",\"model\":\"X100V\",\"serial\":\"FJ2-2025-0043\",\"location\":\"Editorial desk\",\"condition\":\"needs-repair\"}"
bun run equipment-register assets.list --input-json '{"filter":{"location":"Editorial desk","condition":"needs-repair"}}'
bun run equipment-register assets.remove --input-json "{\"id\":\"$ASSET_ID\"}"
bun run equipment-register assets.get --input-json "{\"id\":\"$ASSET_ID\"}"
```

Create, get, and update return complete asset rows. Generated `remove` succeeds with `null`; the final get exits nonzero with `ResourceNotFound`.

The generated `assets.list` accepts equality filters only for `assetTag`, `location`, and `condition`. Its configured limit is both the default and maximum: 100 rows. It returns a cursor when more rows exist, but the Foldkit page asks for the first 100 matching rows and has no next-page control; use the CLI with the returned `nextCursor` and the same filter if you need the next page.

## Input rules and expected failures

| Rule | Observable result |
| --- | --- |
| Tag format | `assetTag` must match `EQ-[A-Z0-9]{4,12}`; for example `EQ-CAM2049` is valid. A lowercase or short tag fails request validation. |
| Asset fields | `name`, `model`, and `location` are non-empty; `serial` is either a non-empty string or `null`; `condition` is `in-service`, `needs-repair`, or `retired`. |
| Unique tag | A second stored row with the same `assetTag` violates the declared unique constraint and surfaces as `RepositoryError`; change the tag or remove the earlier record. |
| Missing UUID | `assets.get`, `assets.update`, and `assets.remove` report `ResourceNotFound` for a well-formed ID with no row. |
| Lists | An undeclared filter, invalid limit, or invalid cursor is rejected as `RepositoryError`. Limits run from 1 through 100; preserve a non-null cursor exactly with the same encoded filter. |

At `http://127.0.0.1:3000/`, the Foldkit UI offers filters by tag, location, and condition; a first-page table; and controls to register, edit, or remove a record. Empty serial input is sent as `null`. It is an equipment register, not a checkout, maintenance-ticket, depreciation, staffing, or production identity system.

## Read next

- [Asset schema](domain.ts), [resource and unique/index declarations](resources.ts), and [frozen migration history](migrations.ts)
- [Application/runtime entry point](main.ts) and [Foldkit register UI](web/main.ts)
- [Official SDK MCP walkthrough](client.ts)
- [Resource CRUD, list, cursor, and implicit UUID contract](../../docs/reference/resources.md)
- [Bun server, CLI endpoint, and MCP adapter setup](../../packages/effect-domains/src/application-bun.ts)
- [MCP RPC envelope implementation](../../packages/effect-domains/src/rpc-mcp.ts) and [runtime reference](../../docs/reference/runtime.md)
