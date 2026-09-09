# Service codec: authorized shared notes with storage-only transformation

This example separates the note a client sees from the representation SQLite stores. It demonstrates a schema codec whose encode and decode functions need an Effect service at runtime, while keeping that service—and its storage convention—out of the HTTP RPC contract.

## What is generated and what is authored

[`domain.ts`](domain.ts) defines the canonical `NoteSchema`: an application-supplied `id` and ordinary text. [`storage.ts`](storage.ts) defines a separate `StoredNoteSchema`. Its `StoredTextSchema` converts canonical text to and from storage text by reading the `StoragePrefix` service.

[`resources.ts`](resources.ts) supplies the canonical schema and storage codec to `Resource.make` with `operations: Resource.crud`. It derives the physical table, generated create/get/list/update/remove procedures, repository, and handlers. No command contracts, service wrapper, or SQL implementation is authored. The generated wire schemas use canonical notes; the table and repository use `StoredNoteSchema`.

The resource uses `Authorization.for({ resource: NoteSchema, subject: ExampleSubjectSchema })`. Its named policy expressions grant read access to `reader`, `editor`, and `admin`; create and update access to `editor` and `admin`; and remove access to `admin` only. `scope: p.all()` deliberately makes notes global shared resources, not tenant-scoped rows. Omitted actions deny access.

This differs from the [todo example](../resource-crud/), whose tenant- and owner-based policy controls individual todo rows. Notes have no tenant or owner field: the role policy is intentionally global. [`main.ts`](main.ts) composes the shared `ExampleAuthentication` authenticator with the `StoragePrefix` service, so the generated handlers have both authorization claims and the storage codec requirement.

This keeps the prefix out of the transport boundary: the CLI sends and receives ordinary text, not `stored:` values. Missing rows and persistence or schema failures use the generic generated `ResourceNotFound` and `RepositoryError` contracts; denied actions report `Forbidden`, and `remove` returns `void`.

## Run it

Run commands from the repository root. Start the server in one terminal:

```bash
bun run service-codec:server
```

In another terminal, Alice's editor token can create and update a shared note:

```bash
SERVICE_CODEC_TOKEN=alice-demo bun run service-codec notes.create --id note-1 --text "Visible domain text"
SERVICE_CODEC_TOKEN=alice-demo bun run service-codec notes.update --id note-1 --text "Revised domain text"
```

Bob's reader token can read that same shared note but cannot write it:

```bash
SERVICE_CODEC_TOKEN=bob-demo bun run service-codec notes.get --id note-1
SERVICE_CODEC_TOKEN=bob-demo bun run service-codec notes.create --id note-2 --text "Denied write"
```

The second Bob command exits nonzero with `Forbidden`. An administrator can remove the shared note:

```bash
SERVICE_CODEC_TOKEN=admin-demo bun run service-codec notes.remove --id note-1
```

The client-facing values remain `"Visible domain text"` and `"Revised domain text"`; with the server's installed service, SQLite stores their text as `stored:Visible domain text` and `stored:Revised domain text`. `StoredTextSchema` reversibly decodes the storage encoding before returning a canonical note.

## Runtime and persistence

| Setting | Default | Meaning |
| --- | --- | --- |
| `SERVICE_CODEC_DB` | `service-codec.sqlite` | SQLite database file used by the server |
| `PORT` | `3000` | Loopback HTTP port |
| `SERVICE_CODEC_URL` | `http://127.0.0.1:3000/rpc/v1` | RPC endpoint used by the CLI |
| `SERVICE_CODEC_TOKEN` | unset | Demo bearer token sent by the CLI |

The server listens on `127.0.0.1` and uses Effect's JSON RPC protocol, not REST. Use the generated CLI or an Effect `RpcClient`. The demo credentials—`alice-demo`, `bob-demo`, `admin-demo`, and `outsider-demo`—are deliberately public fixtures for loopback examples only, never production authentication.

Run a concurrent instance with distinct server and client settings:

```bash
PORT=3001 SERVICE_CODEC_DB=notes.sqlite bun run service-codec:server
SERVICE_CODEC_URL=http://127.0.0.1:3001/rpc/v1 SERVICE_CODEC_TOKEN=bob-demo bun run service-codec notes.list
```

Startup applies frozen migrations and keeps existing data. It does not reset the database, and the SQLite runtime rejects an untracked database instead of adopting it. The current prefix is hard-coded to `stored:` in `main.ts`. `StoredTextSchema` removes a prefix-length slice when it decodes; it does not validate that stored text begins with that prefix. Do not alter rows manually or change the installed prefix without migrating existing values, or decoded text can be corrupted.

Generated missing-row and persistence failures use `ResourceNotFound` and `RepositoryError`; denied operations use `Forbidden`, and `remove` returns `void`. The generated list is the ordinary unpaginated CRUD list because this resource declares no list policy.

Schema commands run locally without a server. After changing a resource schema, generate against the runtime registry at [`migrations/manifest.json`](migrations/manifest.json):

```bash
bun run service-codec schema generate add-field
bun run service-codec inspect notes.create
```

`generate` writes and atomically registers only a valid next artifact; a blocked plan leaves the manifest untouched. `inspect` exposes canonical and storage schemas, the physical stored schema, and the rendered authorization policy. Do not regenerate artifacts that may already be applied.

## Code map

- [`domain.ts`](domain.ts): canonical note values and identifier.
- [`storage.ts`](storage.ts): `StoragePrefix`, the service-dependent text codec, and physical stored-note schema.
- [`resources.ts`](resources.ts): generated canonical/storage CRUD declaration and shared-note role policy.
- [`application.ts`](application.ts): application registration.
- [`migrations/manifest.json`](migrations/manifest.json) and [frozen artifacts](migrations/): decoded runtime registry and history.
- [`main.ts`](main.ts): the sole runner and composed authentication and prefix services.

See the [examples overview](../README.md), [tenant/owner todo CRUD](../resource-crud/), and [authored book CRUD](../README.md#authored-sql).
