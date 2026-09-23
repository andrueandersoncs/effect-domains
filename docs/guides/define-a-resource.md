# Define a resource

Use this guide when you need a small, unauthenticated CRUD endpoint backed by SQLite. It creates a scratch application directly under this checkout; it does not add a Bun workspace package or change the repository configuration. The result exposes `books.create`, `books.get`, `books.list`, `books.update`, `books.patch`, and `books.remove` on the generated Effect RPC endpoint.

`Authorization.public` is intentional here: anyone who can reach the server can use every selected operation. The Bun runner binds the server to `127.0.0.1`; keep this as a local example, not an access-control design. For the operation contract, see the [resource reference](/reference/resources).

## 1. Create the scratch files

From the workspace root, make a place for the source and the reviewed migration artifact:

Run `bun install` first if you have not installed the workspace dependencies. This guide uses the checkout's pinned Effect 4 APIs and does not require the admin build.

```bash
mkdir -p scratch-library/migrations
```

Create `scratch-library/domain.ts`. The schema is the canonical application model. `rating` and `notes` are nullable and therefore optional on create: omitted values become `null`.

```ts
import { Schema } from "effect"

export const BookSchema = Schema.Struct({
  title: Schema.NonEmptyString,
  author: Schema.NonEmptyString,
  status: Schema.Literals(["planned", "reading", "finished"]),
  rating: Schema.NullOr(Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(5),
  )),
  notes: Schema.NullOr(Schema.NonEmptyString),
})
```

Create `scratch-library/resource.ts`. The list accepts equality filters only for `status`, with at most 25 rows per page. Each capability is an inspectable syntax value; `Resource.define` does not run the compiler.

```ts
import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { BookSchema } from "./domain.ts"

export const Books = Resource.define({
  name: "books",
  schema: BookSchema,
  authorization: Authorization.public,
  capabilities: Resource.capabilities(
    Resource.get(),
    Resource.list({
      filter: ["status"],
      limit: 25,
    }),
    Resource.create(),
    Resource.update(),
    Resource.remove(),
    Resource.patch(),
  ),
})
```

Create `scratch-library/application.ts` to register the resource in one application:

```ts
import { Effect } from "effect"
import { Application, Part } from "effect-domains/application"
import { Books } from "./resource.ts"

export const Library = Effect.runSync(Application.compile(Application.define({
  name: "library",
  parts: [Part.resource(Books)],
})))
```

## 2. Author and freeze the initial migration

Create `scratch-library/author-initial-migration.ts`. It derives a fresh-table artifact from `Resource.table(Books)`, encodes it as JSON, validates it as a history, and prints it. It does not open or alter a database.

```ts
import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Schema, pipe } from "effect"
import { Resource } from "effect-domains/resource"
import { SqliteMigration, SqliteMigrations } from "effect-domains/sqlite-migrations"
import { Books } from "./resource.ts"

const initial = SqliteMigrations.initial({
  id: "001_initial",
  tables: [Resource.table(Books)],
})
const codec = Schema.toCodecJson(SqliteMigration)

const program = Effect.gen(function* () {
  const artifact = yield* Schema.encodeEffect(codec)(initial)
  SqliteMigrations.history(artifact)
  yield* Console.log(JSON.stringify(artifact, null, 2))
})

pipe(program, BunRuntime.runMain)
```

Generate the artifact, inspect the resulting `scratch-library/migrations/001_initial.json`, and treat it as frozen once a database has applied it:

```bash
bun run scratch-library/author-initial-migration.ts > scratch-library/migrations/001_initial.json
```

The file is one JSON object with `id: "001_initial"`, the derived `books` table in `to.tables`, and a name-referenced `SqliteCreateTable` step. For subsequent schema changes, append a separately reviewed artifact; do not regenerate this file for an existing database.

Create `scratch-library/migrations.ts` to import and validate the ordered history:

```ts
import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import initial from "./migrations/001_initial.json" with { type: "json" }

export const LibraryMigrations = SqliteMigrations.history(initial)
```

## 3. Add the Bun entrypoint

Create `scratch-library/main.ts`:

```ts
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { Library } from "./application.ts"
import { LibraryMigrations } from "./migrations.ts"

pipe(ApplicationBun.runApplication(Library, {
  database: { migrations: LibraryMigrations },
}), ApplicationBun.runMain)
```

`ApplicationBun.runApplication` supplies the `serve` command and generated CLI; `ApplicationBun.runMain` runs its Effect. Without an explicit `filename`, this app reads `LIBRARY_DB` and otherwise uses `data/library.sqlite`.

## 4. Run and exercise the resource

Start the local server from the workspace root. This first startup applies the imported initial artifact to the named SQLite file.

```bash
PORT=3001 LIBRARY_DB="$PWD/scratch-library/library.sqlite" bun run scratch-library/main.ts serve
```

In another terminal, point the generated CLI at that server and create a book:

```bash
export LIBRARY_URL=http://127.0.0.1:3001/rpc/v1
bun run scratch-library/main.ts books.create --input-json '{"title":"The Dispossessed","author":"Ursula K. Le Guin","status":"planned"}'
```

The command prints a complete book row. It includes a generated UUIDv7 `id`; `rating` and `notes` are `null` because nullable fields default to `null` on create. Copy that identifier into `BOOK_ID`, then list and patch it:

```bash
bun run scratch-library/main.ts books.list --input-json '{"filter":{"status":"planned"},"limit":10}'
BOOK_ID='copy-the-returned-id-here'
bun run scratch-library/main.ts books.patch --input-json "{\"key\":\"$BOOK_ID\",\"changes\":{\"status\":\"reading\"}}"
bun run scratch-library/main.ts books.get --input-json "{\"id\":\"$BOOK_ID\"}"
```

`books.list` returns `{ items, nextCursor }`; `nextCursor` is `null` until another page exists. The patch result and subsequent get show the complete row with `status: "reading"`.

For this resource, create input requires nonempty `title` and `author` plus one of the three `status` values; `rating` may be `null` or an integer from 1 through 5; `notes` may be `null` or a nonempty string. Update is different: `books.update` accepts the complete returned row, including `id`, while patch accepts `{ key, changes }` and cannot change the identifier. `books.remove` accepts `{ id }` and returns `void`.

## Continue building

The runner can expose a generated Application UI by setting `ui: true` beside `database`. Build the shared assets with `bun run build`, restart the server, and open `http://127.0.0.1:3001/`. The UI interprets the compiled application's operations and resource inspection; no resource-specific browser client is required.

Before using this pattern for private data, [restrict access](/guides/authorization). When a stored schema changes, [append a migration](/guides/migrations) instead of regenerating the initial artifact. See [runtime and clients](/reference/runtime) for environment variables and endpoints.

## Implementation sources

- [`Resource.define` and `Resource.compile`](../../packages/effect-domains/src/resource.ts) separate declarative capability/creation syntax from table, repository, RPC, and handler derivation.
- [`Application.define` and `Application.compile`](../../packages/effect-domains/src/application.ts) separate explicit parts from the authoritative `ApplicationIR`; compilation returns a typed Effect, executed explicitly by the application module before runtimes and adapters consume the IR.
- [`SqliteMigrations.initial`](../../packages/effect-domains/src/sqlite-migrations.ts) is for a fresh table/index artifact. Import frozen artifacts with `SqliteMigrations.history(...)`.
- [`ApplicationBun.runApplication`](../../packages/effect-domains/src/application-bun.ts) creates the command Effect that hosts RPC at `/rpc/v1`, exposes the client CLI, defaults `PORT` to 3000, and derives the database environment prefix from the application name.
