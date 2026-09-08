# Service codec: canonical notes with storage-only transformation

This example separates the note a client sees from the representation SQLite stores. It demonstrates a schema codec whose encode and decode functions need an Effect service at runtime, while keeping that service—and its storage convention—out of the HTTP RPC contract.

## What is generated and what is authored

[`domain.ts`](domain.ts) defines the canonical `NoteSchema`: an application-supplied `id` and ordinary text. [`storage.ts`](storage.ts) defines a separate `StoredNoteSchema`. Its `StoredTextSchema` converts canonical text to and from storage text by reading the `StoragePrefix` service.

[`resources.ts`](resources.ts) builds the physical `notes` table from the storage schema and deliberately selects `operations: []`. [`contracts.ts`](contracts.ts) declares five named canonical `{ input, output, error }` contracts; `Application.make` derives their RPCs and group, and `CommandService` derives the `Notes` service signatures. The SQL-backed handlers in [`sqlite.ts`](sqlite.ts) remain authored. They expose canonical notes to clients while executing storage queries with `StoredNoteSchema`.

This keeps the prefix out of the transport boundary: the CLI sends and receives ordinary text, not `stored:` values. It also means the codec requirement is explicit in the storage layer rather than becoming a global RPC convention. [`server.ts`](server.ts) creates the actual service scope with:

```ts
const prefix = Layer.succeed(StoragePrefix, { value: "stored:" })
const services = Layer.provide(NotesSqlite, prefix)
```

`NotesSqlite` captures that service and provides it to every stored create, get, list, update, and remove query. The exported `createKeepsCodecRequirement` check in [`sqlite.ts`](sqlite.ts) documents that the query itself retains the `StoragePrefix` requirement.

## Run it

Run commands from the repository root. Start the server in one terminal:

```bash
bun run service-codec:server
```

In another terminal, exercise the canonical note interface:

```bash
bun run service-codec notes.create --id note-1 --text "Visible domain text"
bun run service-codec notes.get --id note-1
bun run service-codec notes.update --id note-1 --text "Revised domain text"
bun run service-codec notes.list
bun run service-codec notes.remove --id note-1
```

The client-facing values remain `"Visible domain text"` and `"Revised domain text"`; with the server's installed service, SQLite stores their text as `stored:Visible domain text` and `stored:Revised domain text`.

## Runtime and persistence

| Setting | Default | Meaning |
| --- | --- | --- |
| `SERVICE_CODEC_DB` | `service-codec.sqlite` | SQLite database file used by the server |
| `PORT` | `3000` | Loopback HTTP port |
| `SERVICE_CODEC_URL` | `http://127.0.0.1:3000/rpc/v1` | RPC endpoint used by the CLI |

The server listens on `127.0.0.1` and uses Effect's JSON RPC protocol, not REST. Use the generated CLI or an Effect `RpcClient`; no authentication is supplied. Run a concurrent instance with distinct server and client settings:

```bash
PORT=3001 SERVICE_CODEC_DB=notes.sqlite bun run service-codec:server
SERVICE_CODEC_URL=http://127.0.0.1:3001/rpc/v1 bun run service-codec notes.list
```

Startup applies frozen migrations and keeps existing data. It does not reset the database, and the SQLite runtime rejects an untracked database instead of adopting it. The current prefix is hard-coded to `stored:` in the server. `StoredTextSchema` removes a prefix-length slice when it decodes; it does not validate that stored text begins with that prefix. Do not alter rows manually or change the installed prefix without migrating existing values, or decoded text can be corrupted.

`get`, `update`, and `remove` return `NoteNotFound` when the id is absent. Storage/query failures become `NotesPersistenceFailure` with the operation name. `remove` returns `void`, and the list query defines neither ordering nor pagination.

Schema commands run locally without a server:

```bash
bun run service-codec schema snapshot --out current-schema.json
bun run service-codec schema plan --id 002_change \
  --from examples/service-codec/migrations/001_initial.json \
  --out 002_change.json
```

Review a planned artifact before adding it to [`migrations.ts`](migrations.ts). Do not regenerate artifacts that may already be applied.

## Code map

- [`domain.ts`](domain.ts): canonical note values, identifier input, and public errors.
- [`storage.ts`](storage.ts): `StoragePrefix`, the service-dependent text codec, and physical stored-note schema.
- [`resources.ts`](resources.ts): physical table declaration and deliberate opt-out from generated resource RPCs.
- [`contracts.ts`](contracts.ts) and [`service.ts`](service.ts): canonical command declarations and the derived service boundary.
- [`sqlite.ts`](sqlite.ts): `Query.make` storage operations, canonical/storage conversion, and error translation.
- [`migrations.ts`](migrations.ts) and [`migrations/001_initial.json`](migrations/001_initial.json): decoded frozen schema history.
- [`application.ts`](application.ts), [`server.ts`](server.ts), and [`cli.ts`](cli.ts): application registration, actual prefix scope, server, and CLI.

See the [examples overview](../README.md), [generated todo CRUD](../resource-crud/), and [authored book CRUD](../basic-crud/).
