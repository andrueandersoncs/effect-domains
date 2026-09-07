# Effect Domains

Effect Domains derives tables, codecs, repositories, RPC contracts, HTTP dispatch, and CLI flags from canonical Effect Schemas. Applications choose which resource operations to expose and supply business policy.

## Declare an application

```ts
import { Schema } from "effect"
import { Application } from "effect-domains/application"
import { Resource } from "effect-domains/resource"

const BookSchema = Schema.Struct({
  title: Schema.NonEmptyString,
  pageCount: Schema.Int.check(Schema.isGreaterThan(0)),
  publishedAt: Schema.DateTimeUtc,
})

const Books = Resource.make({
  name: "books",
  schema: BookSchema,
  operations: ["create", "get", "list", "update", "remove"],
})

export const Library = Application.make({
  name: "library",
  resources: [Books],
})
```

This supplies a generated UUIDv7 key, SQL columns and supported checks, timestamp storage codecs, a typed `Books.repository`, and the selected `books.*` RPC operations. There is no second storage schema, CRUD query implementation, or transport model.

`ApplicationBun.serve` prepares the database and serves the application's native Effect RPC group. `ApplicationBun.cli` derives commands, scalar flags, validation, and help from that group. The [reservation server](examples/reservations/server.ts) and [CLI](examples/reservations/cli.ts) show the runtime entrypoints.

Adding a supported scalar field to `BookSchema` changes fresh-table creation, repository input/output, RPC codecs, and CLI flags without per-layer field edits. Existing databases require a reviewed migration artifact; startup does not silently alter them.

## Resource and command boundaries

`Resource.make` supplies:

- `table`: the derived table definition and row codecs;
- `repository`: `find`, `get`, `list`, `create`, `update`, and `remove` Effects;
- `group` and `handlers`: only the operations selected in `operations`.

`find` returns an `Option`; `get`, `update`, and `remove` report `ResourceNotFound` for missing records. Persistence and codec failures use `RepositoryError`. Creation uses the source schema; update uses the complete persisted row, including its identifier.

Use `operations: []` for an internal-only repository. Registering a resource does not publish every mutation. The reservation application exposes only resource reads; reserve, confirm, and release remain explicit business commands.

Declare custom commands with Effect's `Rpc` and `RpcGroup`, then pass the group as `Application.make({ name, resources, commands })`. `CommandService<typeof commands>` derives their domain-facing service signatures. `application.toLayer` combines their implementations with generated resource handlers. There is no competing operation DSL.

## Storage conventions

`Table.make({ name, schema })` accepts flat, required, string-named fields. Supported storage includes strings, integers, real numbers, nullable scalars, literals/enums, native booleans, and UTC timestamps. Booleans use checked `0`/`1` integers; `DateTime.Utc` uses ISO text without losing milliseconds. Explicit scalar codecs retain their declared encoding and Effect service requirements.

The SQLite interpreter derives primary keys, nullability, scalar type checks, supported numeric bounds, enum membership, and string-length checks. Arbitrary predicates remain runtime schema validation; they are not advertised as SQL constraints. Nested records, optional columns, and opaque values without a supported scalar encoding are rejected.

Without `identifier`, a table adds a persistence-only UUIDv7 `id`; the canonical schema stays unchanged. Mark one intrinsic identity field with `identifier` from `effect-domains/domain` to use it instead. Explicit identifiers must be supplied by the application. An unannotated source field named `id` is rejected.

`SqliteBunRuntime.sqlClient` provides the database, table, repository, and schema stores over one SQL client. Authored transactions therefore include generated repository operations.

## Migrations

`SqliteMigrations.snapshot` captures a physical schema. `SqliteMigrations.plan` compares frozen snapshots and emits a reviewable JSON artifact. Its native CLI can generate snapshots and plans from an application without a running server.

Fresh tables and nullable additions are mechanical. Renames, required-field backfills, and storage transformations require explicit intent. Historical artifacts contain frozen metadata, not imports of the latest domain schema. The runtime checks history and schema drift, refuses untracked tables, and applies rebuilds transactionally.

See the [migration workflow](examples/README.md#review-schema-changes) for commands and supported boundaries.

## Run the reservation application

```bash
bun install
bun run reservations:server
```

In another terminal:

```bash
bun run reservations stock.get --sku book
bun run reservations reserve --sku book --quantity 2
bun run reservations reservations.get --help
```

The example is loopback-only and unauthenticated. Its [guide](examples/README.md#reservation-application) covers release, confirmation, configuration, and migration history. The [validation record](docs/wiki/validation-strategy.md#reservation-slice) separates exercised behavior from unresolved framework questions.

## Escape hatches and documentation

`Query.make({ table, Request, Result, implementation })` remains the schema-checked seam for custom queries. `PersistedRef.make({ commit, load })` composes persistence operations into a synchronized, write-through value. Neither replaces explicit authorization, transaction, concurrency, or recovery policy.

- [Runnable examples](examples/README.md)
- [Project wiki](docs/wiki/README.md)
- [Tables and queries](docs/wiki/tables-and-queries.md)

## Development

```bash
bun run check
bun run lint
bun run test
```
