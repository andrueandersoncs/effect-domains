# Repair workshop: a joined repair board

[All examples](../README.md)

Register a customer and a technician, create assigned and unassigned repairs, then change the technician's details and see the board update without rewriting the repairs. This example demonstrates current joined values, nullable relationships, and declared query dependencies. It is a public local repair register, not a production workshop-management system.

## Run it

Use Bun and run every command from the repository root. Start with a fresh database for this walkthrough because customer and technician IDs are supplied explicitly:

```bash
bun install
bun run build
export REPAIR_WORKSHOP_DB="$(mktemp -d)/repair-workshop.sqlite"
bun run repair-workshop:server
```

Leave this terminal running. The server provides:

- A hand-authored Foldkit board at [http://127.0.0.1:3000/](http://127.0.0.1:3000/).
- The generated admin at [http://127.0.0.1:3000/admin](http://127.0.0.1:3000/admin).
- Effect JSON RPC at `http://127.0.0.1:3000/rpc/v1` and Streamable HTTP MCP at `http://127.0.0.1:3000/mcp`.

No bearer token is required. Keep the server on loopback. The build is required for the frontend and admin assets.

## Register customers and technicians

In a second terminal at the repository root:

```bash
bun run repair-workshop customers.create --input-json '{"id":"river","name":"River Cycles"}'
bun run repair-workshop technicians.create --input-json '{"id":"sam","name":"Sam","onCall":true}'
```

Each command returns the record you supplied. Customer and technician `id` values are canonical nonempty strings, not generated UUIDs. Names must be nonempty; `onCall` is a required boolean. Reusing either ID fails rather than updating its record.

## Create assigned and unassigned repairs

```bash
bun run repair-workshop repair_jobs.create --input-json '{"customerId":"river","item":"Cargo bike","fault":"Brake rub","urgent":true,"technicianId":"sam"}'
bun run repair-workshop repair_jobs.create --input-json '{"customerId":"river","item":"Commuter bike","fault":"Wheel wobble"}'
bun run repair-workshop workshop.board --input-json '{"status":"queued","limit":25}'
```

Repairs receive generated UUIDv7 identifiers. Copy the cargo bike's returned `id` into a variable for later steps:

```bash
REPAIR_ID='paste-the-cargo-bike-id-here'
```

The omitted fields on creation default to `urgent: false`, `status: "queued"`, and `technicianId: null`. The board returns an array with the urgent cargo bike first, followed by the commuter bike. On this fresh database, both have `customerName: "River Cycles"`; the cargo bike has `technicianName: "Sam"` and `technicianOnCall: true`. The unassigned row has `null` for all three technician fields.

The board includes `id`, `customerId`, `customerName`, `item`, `fault`, `urgent`, `status`, `technicianId`, `technicianName`, and `technicianOnCall`. Boolean values are canonical JSON booleans, not SQLite integers. Customer and technician names are read from their current records, not copied into repair rows.

## Change the values the board joins

```bash
bun run repair-workshop customers.patch --input-json '{"key":"river","changes":{"name":"River Cycle Works"}}'
bun run repair-workshop technicians.patch --input-json '{"key":"sam","changes":{"name":"Samuel","onCall":false}}'
bun run repair-workshop workshop.board
```

Both board rows now have the new customer name. The assigned repair has `technicianName: "Samuel"` and `technicianOnCall: false`; the unassigned repair still has null technician fields. The no-input board command uses its all-optional payload as `{}`.

Now advance and unassign the cargo bike:

```bash
bun run repair-workshop repair_jobs.patch --input-json "{\"key\":\"$REPAIR_ID\",\"changes\":{\"status\":\"repairing\",\"technicianId\":null}}"
bun run repair-workshop workshop.board --input-json '{"status":"repairing"}'
bun run repair-workshop repair_jobs.get --input-json "{\"id\":\"$REPAIR_ID\"}"
```

The filtered board contains the cargo bike with null technician fields. The ordinary get returns the repair itself, without the joined names. `patch` takes `{ key, changes }`; `get` and `remove` take `{ id }`. A full `update` requires the entire row, including `id` and nullable fields. See the [generated operation contract](../../docs/reference/resources.md#read-update-remove-and-patch-contracts).

The allowed statuses are `queued`, `repairing`, and `ready`. These are editable record values: nothing prevents moving from ready back to queued or assigning a technician who is not on call. A joined read does not implement scheduling policy or guarded business transitions.

## Understand the two list shapes

| Read | Result and bounds |
| --- | --- |
| `workshop.board` | Array; optional `status`; default limit 50, allowed limits 1–100; urgent first, then identifier ascending; no cursor |
| `repair_jobs.list` | `{ items, nextCursor }`; equality filters on `status`, `customerId`, `technicianId`; default and maximum 50; identifier ascending |
| `customers.list`, `technicians.list` | `{ items, nextCursor }`; default and maximum 50; identifier ascending; no declared field filters |

For example:

```bash
bun run repair-workshop repair_jobs.list --input-json '{"filter":{"customerId":"river","status":"queued"},"limit":10}'
bun run repair-workshop workshop.board --input-json '{"limit":1}'
```

A board limit truncates the matching array; it does not provide a way to request the next board page. For generated lists, pass a non-null `nextCursor` back unchanged as `cursor`, with the same filters. See [generated lists](../README.md#generated-lists).

## Observe referential and validation failures

Run these individually; both should exit nonzero:

```bash
bun run repair-workshop repair_jobs.create --input-json '{"customerId":"missing","item":"Road bike","fault":"Puncture"}'
bun run repair-workshop customers.remove --input-json '{"id":"river"}'
```

The first cannot reference a nonexistent customer. The second cannot delete a customer still referenced by repairs. Both surface repository failures, not a successful partial write. Nonexistent technicians and deletion of an assigned technician are likewise rejected by foreign keys. There are no cascades.

```bash
bun run repair-workshop workshop.board --input-json '{"limit":101}'
```

This fails the board input schema before execution. Unknown statuses and empty names also fail validation. Missing generated-resource rows produce `ResourceNotFound`; generated storage failures produce `RepositoryError`. The authored board translates SQL/result-codec errors to `RepairWorkshopUnavailable`.

## Use the browser or MCP

At `/`, the **Customers** and **Technicians** forms create records or edit their names and on-call state. **Create repair** uses those records in its selectors. Change a repair's status or technician directly on the board. After a CLI change, choose **Board status** and press **Reload** to fetch current values.

The browser requests up to 100 matching repairs. Customer and technician selectors load 50-row resource pages; **Load next customers** and **Load next technicians** append more choices when a cursor exists. These controls do not paginate the repair board.

The generated admin exposes resource operations plus `workshop.board`. MCP uses those same contracts: call `workshop.board` with `{"input":{"status":"queued","limit":25}}` and read the array from `structuredContent.result`. The MCP endpoint is not the CLI's `/rpc/v1` URL. See [shared MCP conventions](../README.md#mcp-server).

## Runtime and persistence

| Setting | Default | Meaning |
| --- | --- | --- |
| `REPAIR_WORKSHOP_DB` | `data/repair-workshop.sqlite` | Application SQLite file; the walkthrough overrides it with a disposable path |
| `PORT` | `3000` | Loopback server port |
| `REPAIR_WORKSHOP_URL` | `http://127.0.0.1:3000/rpc/v1` | Remote CLI endpoint |

For a second instance, start with `PORT=3004 bun run repair-workshop:server` and set `REPAIR_WORKSHOP_URL=http://127.0.0.1:3004/rpc/v1` in its client terminal. Use a separate database when the records should be separate too.

Stop with Ctrl-C, then restart from the same server terminal so `REPAIR_WORKSHOP_DB` remains set. `workshop.board` should still show the changed names and assignment. Startup replays the frozen [imported history](migrations.ts), preserves existing rows, and rejects untracked database objects rather than adopting them. There is no automatic schema-change planner or startup reset.

For another fresh walkthrough, stop the server and select a new database file; do not delete a database containing work you want to keep. Local contract inspection does not require a running server:

```bash
bun run repair-workshop --help
bun run repair-workshop inspect workshop.board
```

## Follow the implementation

- [`domain.ts`](domain.ts): canonical customer, technician, and repair schemas; board input and error.
- [`resources.ts`](resources.ts): public policies, generated CRUD/patch, creation defaults, foreign keys, and indexes.
- [`board.ts`](board.ts): `SqliteView` selects repair fields, inner-joins the required customer, and left-joins the optional technician; selected storage codecs and output aliases are derived.
- [`contracts.ts`](contracts.ts): native `workshop.board` RPC and its `SqliteView.annotation` dependency declaration.
- [`sqlite.ts`](sqlite.ts): native `SqlSchema` execution owns filtering, urgent-first ordering, bounds, and error translation.
- [`application.ts`](application.ts), [`main.ts`](main.ts): resource/native composition, SQLite history, and browser routes.
- [`web/main.ts`](web/main.ts): authored forms, board, and selector pagination.

A `SqliteView` does not grant access or apply resource authorization to privileged native SQL. This example has no tenant isolation, production identity, staffing calendar, parts inventory, invoices, or business-transition guards. Compare [reservations](../reservations/README.md) for authored transactional transitions and the [joined projection reference](../../docs/reference/resources.md#joined-read-projections) for the derivation API.
