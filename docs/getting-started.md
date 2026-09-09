# Getting Started

This repository is a **private Bun workspace**. Work from its root; the workspace dependencies and runnable examples are already declared here. The basic CRUD application is the smallest generated path: one canonical book schema, one resource declaration, and selected routine operations.

## Install and prebuild

Install the workspace, then prebuild the optional browser admin assets:

```bash
bun install
bun run build
```

The root [package scripts](../package.json) define the commands. The build is required before an application enables the generated admin; the runtime serves the prebuilt assets rather than compiling a browser application on startup.

## Run the basic CRUD server

In one terminal, start the loopback server:

```bash
bun run basic-crud:server
```

The application uses SQLite with frozen migration history. By default it listens on `http://127.0.0.1:3000`, and its generated RPC endpoint is `http://127.0.0.1:3000/rpc/v1`.

The resource is intentionally small and public:

```ts
export const BookResource = Resource.make({
  authorization: Authorization.public,
  name: "books",
  schema: BookSchema,
  operations: Resource.crud,
})
```

Read the complete [resource declaration](../apps/basic-crud/resources.ts), [application registration](../apps/basic-crud/application.ts), and [Bun entrypoint](../apps/basic-crud/main.ts). `Resource.crud` selects the generated `get`, `list`, `create`, `update`, and `remove` operations; it does not author a separate query layer.

## Create and list books

In another terminal, use the generated CLI against the running server:

```bash
bun run basic-crud books.create --title "A Field Guide" --page-count 120
bun run basic-crud books.list
```

The runtime generates the book identifier. To retrieve a created row, copy that UUIDv7 value into `BOOK_ID`:

```bash
bun run basic-crud books.get --id "$BOOK_ID"
```

The [basic CRUD README](../apps/basic-crud/README.md) documents complete-row updates, removal, database and endpoint environment variables, and the expected domain errors.

## Open the admin surface

With the server running, open [http://127.0.0.1:3000/admin](http://127.0.0.1:3000/admin). This opt-in administrative interface uses the same published RPC operations; it is not a separate application contract. The entrypoint explicitly enables it with `admin: true`.

## Inspect contracts and migrations

Inspection and schema commands run locally; they do not require the server:

```bash
bun run basic-crud inspect books.create
bun run basic-crud schema generate add-field
```

Review generated migration artifacts before applying them. Do not regenerate history that is already applied from the current model.

## Continue in the wiki

- [Thesis](/wiki/thesis) — the central claim and the derivation boundary.
- [Tables and Queries](/wiki/tables-and-queries) — the resource, authorization, persistence, and runtime contract.
- [Research Agenda](/wiki/research-agenda) — implemented scope and open questions.
- [Validation Strategy](/wiki/validation-strategy) — exercised evidence and its limits.
