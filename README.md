# Effect Domains

Effect Domains derives tables, codecs, repositories, RPC contracts, HTTP dispatch, and CLI flags from canonical Effect Schemas. Applications choose which resource operations to expose and supply business policy.

The repository root is a private Bun workspace. `packages/effect-domains` is the framework library, `packages/example-support` holds shared demo authentication and `BookSchema`, and `apps/` contains the seven runnable applications. `apps/admin` is the separately built browser application; after `bun install`, run `bun run build` to prebuild its assets. At runtime the Bun adapter only loads those prebuilt assets.

## Declare an application

```ts
import { Schema } from "effect"
import { Application } from "effect-domains/application"
import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"

const BookSchema = Schema.Struct({
  title: Schema.NonEmptyString,
  pageCount: Schema.Int.check(Schema.isGreaterThan(0)),
  publishedAt: Schema.DateTimeUtc,
})

const Books = Resource.make({
  name: "books",
  schema: BookSchema,
  authorization: Authorization.public,
  operations: Resource.crud,
})

export const Library = Application.make({
  name: "library",
  resources: [Books],
})
```

This supplies a generated UUIDv7 key, SQL columns and supported checks, timestamp storage codecs, a typed `Books.repository`, and the selected `books.*` RPC operations. `Application.make` groups optional `resources` and `commands`; omitted groups are empty. There is no second storage schema, CRUD query implementation, or transport model.

`ApplicationBun.run(application, options)` returns the application Effect; execute it with native `BunRuntime.runMain`. A manifest may be a path or `URL`, and `filename`, `services`, and `initialize` are optional:

```ts
import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"

const manifest = new URL("./migrations/manifest.json", import.meta.url)

pipe(ApplicationBun.run(Library, {
  database: { manifest },
  admin: true,
}), BunRuntime.runMain)
```

Pass `database: { manifest, filename }` to choose a database file, `services` only when handlers need authored services, and `initialize` only for startup work. Callers that already own decoded history can instead pass `database: { migrations }`. `admin: true` is opt-in; the [applications' shared admin guide](apps/README.md#generated-admin) covers its generated UI and browser boundary. Start with [basic-crud](apps/basic-crud/README.md); the [reservation application](apps/reservations/application.ts) adds explicit business commands.

Adding a supported scalar field to `BookSchema` changes the derived table, repository input/output, RPC codecs, and CLI flags without per-layer field edits. Every nonempty managed database requires reviewed migration history, including fresh databases; startup never bootstraps or adopts tables outside that history.

## Resource and command boundaries

`Resource.make` supplies:

- `table`: the derived table definition and row codecs;
- `repository`: `find`, `get`, `list`, `page`, `create`, `update`, `patch`, and `remove` Effects;
- `group` and `handlers`: only the operations selected in `operations`.

`find` returns an `Option`; missing records use `ResourceNotFound`, and persistence/codec failures use `RepositoryError`. Creation applies declared defaults and runtime-generated fields. Update validates the complete row; patch preserves its identifier and validates the merged row transactionally. A declared list policy supplies bounded cursor pages.

Published patch payloads are `{ key, changes }`, independent of the identifier's field name. The local repository remains `patch(key, changes)`. Exact filters use compiled physical field codecs; declared ordering rejects semantic codecs whose physical order is not proven equivalent.

Use `operations: []` for an internal-only repository. Registering a resource does not publish every mutation. The reservation application exposes only resource reads; reserve, confirm, and release remain explicit business commands.

`Commands.make({ name, group })` takes a native Effect `RpcGroup` and supplies an injectable service and handler layer. `Commands.rpc(tag, { payload, success, error })` derives JSON codecs; native `Rpc.make` remains available. Install implementations through `descriptor.layer(handlers, catchTags)` and register descriptors in `Application.make({ name, resources, commands: [descriptor] })`. The optional mapper record handles matching tagged invocation errors after transactions and handler scopes unwind, not acquisition failures, defects, or interruption. Every mapper that may run must preserve the RPC success/error contract, including optional entries. Local calls retain middleware-provided service requirements and close their invocation scope before returning. Resource-only applications can omit `commands`; `Application.prepare(application)` prepares tables through the migration store.

RPCs may share schemas without sharing business behavior: the [reservation RPCs](apps/reservations/contracts.ts) reuse transition options for `confirm` and `release`. The supplied group is retained, including its RPC definitions and annotations; there is no parallel command-contract format. Local service methods accept decoded payloads and return unary Effects; the runtime chooses HTTP transport separately.

For example, an authored operation keeps its meaningful contract without wire-schema variables:

```ts
const createBook = Commands.rpc("books.create", {
  payload: BookSchema,
  success: BookResource.table.rowSchema,
  error: BookPersistenceError,
})
```

Routine CRUD needs none of these declarations: select `Resource.crud` instead. The [authored SQL example](apps/README.md#authored-sql) deliberately keeps custom SQL, errors, and a remove operation returning the deleted row.

## Resource authorization

Every resource declares `authorization`: `Authorization.public`, `Authorization.deny`, or a typed policy. This declaration belongs to the resource, never to its canonical schema. Public examples remain explicitly unauthenticated.

```ts
const DocumentSchema = Schema.Struct({ tenantId: Schema.String, ownerId: Schema.String, title: Schema.String })
const SubjectSchema = Schema.Struct({ tenantId: Schema.String, userId: Schema.String, roles: Schema.Array(Schema.String) })
const p = Authorization.for({ resource: DocumentSchema, subject: SubjectSchema })
const owned = p.eq(p.row.ownerId, p.subject.userId)
const admin = p.includes(p.subject.roles, "admin")
const authorization = p.policy({
  scope: p.eq(p.row.tenantId, p.subject.tenantId),
  allow: {
    read: p.any(owned, admin),
    create: p.eq(p.next.ownerId, p.subject.userId),
    update: p.all(owned, p.unchanged("ownerId")),
    patch: p.all(owned, p.unchanged("ownerId")),
    remove: owned,
  },
})
const Documents = Resource.make({
  name: "documents",
  schema: DocumentSchema,
  authorization,
  create: {
    fromSubject: { tenantId: p.subject.tenantId, ownerId: p.subject.userId },
  },
  operations: [...Resource.crud, "patch"],
})
```

Missing actions deny access. Scope always applies, including to candidate rows. `row` is current state and `next` is the complete candidate, after creation defaults, subject bindings, generation, or patch merging. Read policies cannot reference `next`; create policies cannot reference `row`.

`create.fromSubject` derives named create fields from typed `p.subject` operands. Those fields are omitted from the generated create input; a supplied bound field is rejected before authorization, and the server injects trusted subject claims before checking the candidate policy.

Repositories enforce policy even when invoked by authored code. Hidden rows behave as missing; lists filter in SQL before pagination. Create/update/patch require a readable candidate, and returned rows are checked again. Checks and writes share a transaction, so a denied mutation leaves no changes. Missing or invalid identity yields `Unauthenticated`; denied actions yield `Forbidden`.

Protected generated RPCs use request-local `AuthorizationSubject`, supplied by `AuthorizationRpc.Authenticator` from `effect-domains/authorization-rpc`. Provide that service through the application's `services` layer. Its `authenticate(headers)` Effect verifies credentials and returns trusted claims or fails with `Unauthenticated`; the framework does not trust caller-supplied identity headers or issue tokens. The CLI sends `<APP>_TOKEN` as a bearer token. Local authored Effects can supply `AuthorizationSubject` explicitly; `Authorization.require(definition, action, values)` evaluates policy outside a repository.

The closed `Policy` AST supports constants, total scalar equality, collection membership, conjunction, and disjunction. Its fold drives evaluation, SQL, reference validation, and inspection. SQL visibility fields must use identical, identity-encoded canonical and storage schemas. Supported physical values are strings and finite numeric scalars; booleans are supported only by the native Boolean-to-checked-`0`/`1` SQLite mapping. Arbitrary semantic codecs are rejected rather than approximated. Standalone evaluation supports booleans too. Native `SqlClient` and `RepositoryStore` are privileged escape hatches, not authorization boundaries.

## Storage conventions

`Table.make({ name, schema })` accepts flat, required, string-named fields. Supported storage includes strings, integers, real numbers, nullable scalars, literals/enums, native booleans, and UTC timestamps. Booleans use checked `0`/`1` integers; `DateTime.Utc` uses ISO text without losing milliseconds. Explicit scalar codecs retain their declared encoding and Effect service requirements.

The SQLite interpreter derives primary keys, nullability, scalar type checks, supported numeric bounds, and enum membership. JavaScript string-length checks remain schema validation because SQLite counts text differently for surrogate pairs and NUL characters. Suspended scalar schemas retain their automatic storage codecs; nullable physical identifiers are rejected. Nested records, optional columns, and opaque values without a supported scalar encoding are rejected.

Without `identifier`, a table adds a persistence-only UUIDv7 `id`; the canonical schema stays unchanged, and its root checks remain enforced by derived rows and repository writes. Mark one intrinsic identity field with `identifier` from `effect-domains/domain` to use it instead. Explicit identifiers are caller-supplied unless declared in resource creation policy. An unannotated source field named `id` is rejected.

`SqliteBunRuntime.sqlClient` provides Effect's native `SqlClient`, `RepositoryStore`, `SchemaStore`, and runtime values over one connection. Authored transactions include generated repository operations. `Table` is a typed descriptor, not an executable store; migrations own schema creation.

## Migrations

`SqliteMigrations.snapshot` captures a physical schema. `SqliteMigrations.plan` compares frozen snapshots and emits a reviewable JSON artifact. Its native CLI can generate snapshots and plans from an application without a running server.

`SqliteMigrations.decodeHistory(raw)` validates raw artifacts as an Effect; `SqliteMigrations.load(manifest)` reads an ordered manifest. Direct schema-command configuration accepts `manifest: Option<string>` as its only history source. Runtime configuration still accepts either a manifest or decoded history. Intent flags are repeatable; multiple backfills do not require substituting SQL transforms.

Fresh tables and nullable additions are mechanical. Renames, required-field backfills, and storage transformations require explicit intent. Historical artifacts contain frozen metadata, not imports of the latest domain schema. One migration ledger records applied history; the runtime checks artifact contents and actual schema drift, refuses untracked objects, and applies rebuilds transactionally.

Interacting rename chains and cycles rebuild from original source columns. Frozen historical string-length constraints keep their original meaning; the affected examples append explicit `003_schema_string_checks` rebuild migrations rather than rewriting history.

See the [migration workflow](apps/README.md#review-schema-changes) for commands and supported boundaries.

## Run the reservation application

```bash
bun install
bun run build
bun run reservations:server
```

In another terminal:

```bash
bun run reservations stock.get --sku book
bun run reservations reserve --sku book --quantity 2
bun run reservations reservations.get --help
```

The example is loopback-only and unauthenticated. Its [guide](apps/README.md#reservation-application) covers release, confirmation, configuration, and migration history. The [validation record](docs/wiki/validation-strategy.md#reservation-slice) separates exercised behavior from unresolved framework questions.

All seven [example applications](apps/README.md) have persistent SQLite databases, frozen migrations, HTTP servers, generated CLIs, and local schema commands. Run `bun run <example>:server` and use `bun run <example> --help` in another terminal. [Todo rules](apps/resource-crud/resources.ts) demonstrate tenant/owner scope and completion locks; [note rules](apps/service-codec/resources.ts) demonstrate reader/editor/admin permissions alongside a storage codec. Their [demo credentials and walkthroughs](apps/README.md#demo-authentication) are deliberately public and loopback-only. Other examples cover minimal public CRUD, authored queries, a process-local persisted counter, explicit schema evolution, and reservation policy.

## Escape hatches and documentation

Authored SQL uses Effect's `SqlSchema` combinators for request encoding and result decoding, or explicit Schema encode/decode Effects when semantics differ. There is no framework `Query` wrapper or database-service alias. `PersistedRef.make({ commit, load })` composes persistence into a synchronized, write-through value; `fromResource` binds it to one resource key. These helpers do not replace explicit authorization, transaction, concurrency, or recovery policy.

- [Runnable applications](apps/README.md)
- [Project wiki](docs/wiki/README.md)
- [Tables and queries](docs/wiki/tables-and-queries.md)

## Development

Install dependencies and prebuild the admin before running an application:

```bash
bun install
bun run build
```

The root commands check the library, workspace applications, and root integration suite:

```bash
bun run check
bun run lint
bun run test
```
