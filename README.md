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
  commands: [],
})
```

This supplies a generated UUIDv7 key, SQL columns and supported checks, timestamp storage codecs, a typed `Books.repository`, and the selected `books.*` RPC operations. There is no second storage schema, CRUD query implementation, or transport model.

`ApplicationBun.run(application, { database: { manifest, filename }, services, initialize })` supplies one entrypoint for `serve`, generated remote commands, `schema`, and `inspect`. Use `Option.none()` for the environment/default filename, `Layer.empty` when no authored services are needed, and `Effect.void` when no initialization is needed. The [generated CRUD application](examples/resource-crud/application.ts) registers resources; the [reservation application](examples/reservations/application.ts) adds explicit business commands.

Adding a supported scalar field to `BookSchema` changes the derived table, repository input/output, RPC codecs, and CLI flags without per-layer field edits. Every nonempty managed database requires reviewed migration history, including fresh databases; startup never bootstraps or adopts tables outside that history.

## Resource and command boundaries

`Resource.make` supplies:

- `table`: the derived table definition and row codecs;
- `repository`: `find`, `get`, `list`, `page`, `create`, `update`, `patch`, and `remove` Effects;
- `group` and `handlers`: only the operations selected in `operations`.

`find` returns an `Option`; missing records use `ResourceNotFound`, and persistence/codec failures use `RepositoryError`. Creation applies declared defaults and runtime-generated fields. Update validates the complete row; patch preserves its identifier and validates the merged row transactionally. A declared list policy supplies bounded cursor pages.

Use `operations: []` for an internal-only repository. Registering a resource does not publish every mutation. The reservation application exposes only resource reads; reserve, confirm, and release remain explicit business commands.

`Commands.make({ name, group })` takes a native Effect `RpcGroup` and supplies an injectable service and handler layer. Declare operations with `Rpc.make(tag, { payload, success, error })`; apply `Schema.toCodecJson` explicitly where JSON wire codecs are needed. Install authored implementations through `descriptor.layer(handlers)` and register descriptors in `Application.make({ name, resources, commands: [descriptor] })`. Resource-only applications use `commands: []`. `Application.prepare(application)` prepares the resource tables through the migration store.

RPCs may share schemas without sharing business behavior: the [reservation RPCs](examples/reservations/contracts.ts) reuse transition options for `confirm` and `release`. The supplied group is retained, including its RPC definitions and annotations; there is no parallel command-contract format. Local service methods accept decoded payloads and return unary Effects; the runtime chooses HTTP transport separately.

## Storage conventions

`Table.make({ name, schema })` accepts flat, required, string-named fields. Supported storage includes strings, integers, real numbers, nullable scalars, literals/enums, native booleans, and UTC timestamps. Booleans use checked `0`/`1` integers; `DateTime.Utc` uses ISO text without losing milliseconds. Explicit scalar codecs retain their declared encoding and Effect service requirements.

The SQLite interpreter derives primary keys, nullability, scalar type checks, supported numeric bounds, enum membership, and string-length checks. Arbitrary predicates remain runtime schema validation; they are not advertised as SQL constraints. Nested records, optional columns, and opaque values without a supported scalar encoding are rejected.

Without `identifier`, a table adds a persistence-only UUIDv7 `id`; the canonical schema stays unchanged. Mark one intrinsic identity field with `identifier` from `effect-domains/domain` to use it instead. Explicit identifiers are caller-supplied unless declared in resource creation policy. An unannotated source field named `id` is rejected.

`SqliteBunRuntime.sqlClient` provides Effect's native `SqlClient`, `RepositoryStore`, `SchemaStore`, and runtime values over one connection. Authored transactions include generated repository operations. `Table` is a typed descriptor, not an executable store; migrations own schema creation.

## Migrations

`SqliteMigrations.snapshot` captures a physical schema. `SqliteMigrations.plan` compares frozen snapshots and emits a reviewable JSON artifact. Its native CLI can generate snapshots and plans from an application without a running server.

`SqliteMigrations.decodeHistory(raw)` validates raw artifacts as an Effect; `SqliteMigrations.load(manifest)` reads an ordered manifest. Direct schema-command configuration represents optional history and manifest values with `Option`.

Fresh tables and nullable additions are mechanical. Renames, required-field backfills, and storage transformations require explicit intent. Historical artifacts contain frozen metadata, not imports of the latest domain schema. One migration ledger records applied history; the runtime checks artifact contents and actual schema drift, refuses untracked objects, and applies rebuilds transactionally.

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

All six [example applications](examples/README.md) have persistent SQLite databases, frozen migrations, HTTP servers, generated CLIs, and local schema commands. Run `bun run <example>:server` and use `bun run <example> --help` in another terminal. Examples cover generated CRUD, authored queries, service-dependent storage codecs, a process-local persisted counter, explicit schema evolution, and reservation policy.

## Escape hatches and documentation

Authored SQL uses Effect's `SqlSchema` combinators for request encoding and result decoding, or explicit Schema encode/decode Effects when semantics differ. There is no framework `Query` wrapper or database-service alias. `PersistedRef.make({ commit, load })` composes persistence into a synchronized, write-through value; `fromResource` binds it to one resource key. These helpers do not replace explicit authorization, transaction, concurrency, or recovery policy.

- [Runnable examples](examples/README.md)
- [Project wiki](docs/wiki/README.md)
- [Tables and queries](docs/wiki/tables-and-queries.md)

## Development

```bash
bun run check
bun run lint
bun run test
```
