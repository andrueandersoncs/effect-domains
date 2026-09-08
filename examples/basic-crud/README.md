# Basic CRUD: authored book queries

This example shows where to take control of ordinary CRUD. It exposes book create, get, list, update, and remove RPCs, but implements their persistence with authored `Query.make` queries and SQL rather than the generated repository. Use it when the default resource behavior is close but not the contract you want.

## What is generated and what is authored

[`resources.ts`](resources.ts) still uses `Resource.make` to derive the `books` table, its UUIDv7 `id`, row schema, and migration input from the canonical `BookSchema`. Its empty `operations: []` deliberately publishes no generated RPCs.

The five standard operations could instead be derived by selecting `Resource.crud` in `Resource.make`, as [resource-crud](../resource-crud/) does. That route would also supply their handlers. It is not used here because this example deliberately owns both the SQL and the public error/result contracts:

- [`contracts.ts`](contracts.ts) declares all five `books.*` `{ input, output, error }` contracts and passes them to `Commands.make`. That descriptor supplies the injectable command service, derived RPC group, and handler layer.
- [`sqlite.ts`](sqlite.ts) uses `BooksService.layer(...)` to install the authored handler record. It captures its fallback dependencies when the layer is built, while invocation context can still supply dependencies for a handler.
- [`sqlite.ts`](sqlite.ts) implements each operation through `Query.make` and SQL `INSERT`, `SELECT`, `UPDATE`, or `DELETE` with `RETURNING`.
- Missing books become the authored `BookNotFound` error, and database/query failures become `BookPersistenceError`.
- `books.remove` returns the removed book. The generated resource operation returns `void` and uses the generated resource error union instead.

The book's canonical input has `title` and `pageCount`; persistence adds the generated UUIDv7 identifier. This is a contrast with [resource-crud](../resource-crud/), the smallest example that accepts the generated CRUD contract unchanged.

## Run it

Run these commands from the repository root. In one terminal, start the loopback-only server:

```bash
bun run basic-crud:server
```

In another terminal, create and list books:

```bash
bun run basic-crud books.create --input-json '{"title":"A Field Guide","pageCount":120}'
bun run basic-crud books.list
```

Copy the created UUIDv7 `id` into `BOOK_ID`, then exercise the remaining operations:

```bash
bun run basic-crud books.get --id "$BOOK_ID"
bun run basic-crud books.update --input-json "{\"id\":\"$BOOK_ID\",\"title\":\"A Revised Field Guide\",\"pageCount\":144}"
bun run basic-crud books.remove --id "$BOOK_ID"
```

`pageCount` has a finite numeric schema, so the generated CLI accepts it as `--page-count 120`; `--input-json` is still useful for whole payloads and cannot be combined with field flags.

## Runtime and persistence

| Setting | Default | Meaning |
| --- | --- | --- |
| `BASIC_CRUD_DB` | `basic-crud.sqlite` | SQLite database file used by the server |
| `PORT` | `3000` | Loopback HTTP port |
| `BASIC_CRUD_URL` | `http://127.0.0.1:3000/rpc/v1` | RPC endpoint used by the CLI |

The server listens only on `127.0.0.1` and uses Effect's JSON RPC protocol, not REST. Use the generated CLI or an Effect `RpcClient`; there is no authentication. For a concurrent instance, use a distinct port and matching client URL:

```bash
PORT=3001 BASIC_CRUD_DB=books.sqlite bun run basic-crud:server
BASIC_CRUD_URL=http://127.0.0.1:3001/rpc/v1 bun run basic-crud books.list
```

Startup applies the frozen migration history but does not reset existing rows. The SQLite runtime rejects an untracked database rather than adopting it. The authored list query has neither an `ORDER BY` nor pagination, so callers must not rely on a particular order or unbounded production-scale listing. `get`, `update`, and `remove` report `BookNotFound` for a missing id; persistence failures report `BookPersistenceError`.

Schema commands run locally and do not need a server. After changing the resource schema, the runtime reads the ordered artifact registry at [`migrations/manifest.json`](migrations/manifest.json):

```bash
bun run basic-crud schema generate add-field
bun run basic-crud inspect books.create
```

`generate` writes and registers only a valid next artifact; blocked plans leave the manifest unchanged. `inspect` emits the selected RPC contract plus resource schema and storage metadata. Do not regenerate an already applied artifact from current models.

## Code map

- [`domain.ts`](domain.ts): canonical book values, UUIDv7 identifier input, and authored errors.
- [`resources.ts`](resources.ts): table definition and the deliberate opt-out from generated operations.
- [`contracts.ts`](contracts.ts): transport-independent contracts and the `BooksService` command descriptor.
- [`sqlite.ts`](sqlite.ts): `BooksService.layer`, authored `Query.make` implementations, SQL, and error translation.
- [`migrations/manifest.json`](migrations/manifest.json) and [frozen artifacts](migrations/): runtime migration registry and history.
- [`application.ts`](application.ts): resource and command-descriptor registration.
- [`main.ts`](main.ts): the sole server, generated CLI, schema-command, and inspection runner.

See the [examples overview](../README.md), [generated todo CRUD](../resource-crud/), and [service-dependent storage codec](../service-codec/).
