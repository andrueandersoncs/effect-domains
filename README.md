# Effect Domains

Effect Domains derives tables, codecs, repositories, RPC contracts, HTTP dispatch, and JSON CLI inputs from canonical Effect Schemas. Applications choose which resource operations to expose and supply business policy.

The repository root is a private Bun workspace. `packages/effect-domains` is the framework library, `packages/example-support` holds shared demo authentication and `BookSchema`, and `apps/` contains the runnable examples. `apps/admin` is the separately built browser application; after `bun install`, run `bun run build` to prebuild its assets. At runtime the Bun adapter only loads those prebuilt assets.

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

export const Catalog = Application.make({
  name: "catalog",
  parts: [Books],
})
```

An application composes a `parts` array of resources, native RPC bundles, and other applications. Nested resources are flattened; duplicate tables or RPC operation names are rejected. This supplies a generated UUIDv7 key, SQL columns and supported checks, timestamp storage codecs, a typed `Books.repository`, and the selected `books.*` RPC operations. There is no second storage schema, CRUD query implementation, or transport model.

`ApplicationBun.run(application, options)` returns the application Effect; execute it with native `BunRuntime.runMain`. Import reviewed artifact JSONs in order and decode them as an Effect. `filename`, `services`, and `initialize` are optional:

```ts
import { BunRuntime } from "@effect/platform-bun"
import { Effect, pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import initial from "./migrations/001_initial.json" with { type: "json" }

const program = Effect.gen(function* () {
  const migrations = yield* SqliteMigrations.decodeHistory([initial])
  yield* ApplicationBun.run(Catalog, {
    database: { migrations },
    admin: true,
  })
})
pipe(program, BunRuntime.runMain)
```

Pass `database: { migrations, filename }` to choose a database file, `services` only when handlers need authored services, and `initialize` only for startup work. The imported artifact must describe this application's tables; use `SqliteMigrations.initial` to author fresh history as described below. `admin: true` is opt-in; the [applications' shared admin guide](apps/README.md#generated-admin) covers its generated UI and browser boundary. Start with [basic-crud](apps/basic-crud/README.md); the [reservation application](apps/reservations/application.ts) adds explicit business commands.

Adding a supported scalar field to `BookSchema` changes the derived table, repository input/output, RPC codecs, and JSON CLI inputs without per-layer field edits. Every nonempty managed database requires reviewed migration history, including fresh databases; startup never bootstraps or adopts tables outside that history.

## Resource and native RPC boundaries

`Resource.make` supplies:

- `table`: the derived table definition and row codecs;
- `repository`: `find`, `get`, `list`, `create`, `update`, `patch`, and `remove` Effects;
- `group` and `handlers`: only the operations selected in `operations`.

`Resource.crud` is the frozen `{ get: true, list: true, create: true, update: true, remove: true }` selection. Use `patch: true` to add patch. `false` disables an operation; a configured `create` or `list` object with `publish: false` retains its local repository policy but omits its RPC. `operations: {}` keeps every repository method local.

`find` returns an `Option`; missing records use `ResourceNotFound`, and persistence/codec failures use `RepositoryError`. Creation applies declared defaults and runtime-generated fields. Update validates the complete row; patch preserves its identifier and validates the merged row transactionally. Every generated list returns bounded `{ items, nextCursor }`, including local repository `list`. The default limit is 50; declared list configuration can set a limit and equality filters. Order is identifier ascending only. There is no separate `page` method or unbounded generated list.

Published patch payloads are `{ key, changes }`, independent of the identifier's field name. The local repository remains `patch(key, changes)`. Declared equality filters use compiled physical field codecs. Arbitrary ordering is not supported.

Use native Effect RPCs for business operations:

```ts
import { Effect, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"

const health = Rpc.make("library.health", {
  payload: Schema.Void,
  success: Schema.String,
  error: Schema.Never,
})
const LibraryRpcs = RpcGroup.make(health)
const LibraryHandlers = LibraryRpcs.toLayer({
  "library.health": () => Effect.succeed("ok"),
})

export const Library = Application.make({
  name: "library",
  parts: [Catalog, { group: LibraryRpcs, handlers: LibraryHandlers }],
})
```

`Rpc.make` and `RpcGroup.make` retain their native contracts and annotations; `RpcGroup.toLayer` installs handlers. The reservation application exposes only resource reads; reserve, confirm, and release remain explicit native RPCs.

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
  operations: {
    ...Resource.crud,
    patch: true,
    create: {
      fromSubject: { tenantId: p.subject.tenantId, ownerId: p.subject.userId },
    },
  },
})
```

Missing actions deny access. Scope always applies, including to candidate rows. `row` is current state and `next` is the complete candidate, after creation defaults, subject bindings, generation, or patch merging. Read policies cannot reference `next`; create policies cannot reference `row`.

`operations.create.fromSubject` derives named create fields from typed `p.subject` operands. Those fields are omitted from the generated create input and cannot be supplied by callers. The server injects trusted subject claims before checking the candidate policy.

Repositories enforce policy even when invoked by authored code. Hidden rows behave as missing; lists filter in SQL before pagination. Create/update/patch require a readable candidate, and returned rows are checked again. Checks and writes share a transaction, so a denied mutation leaves no changes. Missing or invalid identity yields `Unauthenticated`; denied actions yield `Forbidden`.

Protected generated RPCs use request-local `AuthorizationSubject`, supplied by `AuthorizationRpc.Authenticator` from `effect-domains/authorization-rpc`. Provide that service through the application's `services` layer. Its `authenticate(headers)` Effect verifies credentials and returns trusted claims or fails with `Unauthenticated`; the framework does not trust caller-supplied identity headers or issue tokens. The CLI sends `<APP>_TOKEN` as a bearer token. Local authored Effects can supply `AuthorizationSubject` explicitly; `Authorization.require(definition, action, values)` evaluates policy outside a repository.

The closed `Policy` AST supports constants, total scalar equality, collection membership, conjunction, and disjunction. Its fold drives evaluation, SQL, reference validation, and inspection. SQL visibility fields must use identical, identity-encoded canonical and storage schemas. Supported physical values are strings and finite numeric scalars; booleans are supported only by the native Boolean-to-checked-`0`/`1` SQLite mapping. Arbitrary semantic codecs are rejected rather than approximated. Standalone evaluation supports booleans too. Native `SqlClient` and `RepositoryStore` are privileged escape hatches, not authorization boundaries.

## Storage conventions

`Table.make({ name, schema })` accepts flat, required, string-named fields. Supported storage includes strings, integers, real numbers, nullable scalars, literals/enums, native booleans, and UTC timestamps. Booleans use checked `0`/`1` integers; `DateTime.Utc` uses ISO text without losing milliseconds. Explicit scalar codecs retain their declared encoding and Effect service requirements.

The SQLite interpreter derives primary keys, nullability, scalar type checks, supported numeric bounds, and enum membership. JavaScript string-length checks remain schema validation because SQLite counts text differently for surrogate pairs and NUL characters. Suspended scalar schemas retain their automatic storage codecs; nullable physical identifiers are rejected. Nested records, optional columns, and opaque values without a supported scalar encoding are rejected.

Without `identifier`, a table adds a persistence-only UUIDv7 `id`; the canonical schema stays unchanged, and its root checks remain enforced by derived rows and repository writes. Mark one intrinsic identity field with `identifier` from `effect-domains/domain` to use it instead. Explicit identifiers are caller-supplied unless declared in resource creation policy. An unannotated source field named `id` is rejected.

`SqliteBunRuntime.sqlClient` provides Effect's native `SqlClient`, `RepositoryStore`, `SchemaStore`, and runtime values over one connection. Authored transactions include generated repository operations. `Table` is a typed descriptor, not an executable store; migrations own schema creation.

## Migrations

`SqliteMigrations.make({ id, from, to, steps })` constructs an explicit frozen artifact. `initial({ id, tables })` derives fresh creation, and `snapshot(tables)` captures physical metadata. Schema constructors under `SqliteMigrations.steps` and `SqliteMigrations.copies` express changes and source/value/expression rebuild mappings with `.make(...)`. There is no inferred `plan`, `generate`, migration intent DSL, or schema CLI.

`SqliteMigrations.decodeHistory(raw)` validates an ordered array of imported artifact JSONs as an Effect. Runtime accepts `database: { migrations, filename? }` with the decoded history. There is no manifest file, `load`, or `database.manifest` option. Authors review and append new artifacts and imports; already-applied history is never regenerated from current models.

The applied-artifact ledger remains the sole migration state. Runtime checks immutable artifact contents and exact schema/index drift, rejects untracked objects, and verifies the target schema and foreign keys before committing each migration and ledger entry together. Inconsistent steps or invalid rows roll back. Existing artifact JSON histories retain their format and bytes.

See the [explicit authoring walkthrough](apps/README.md#review-schema-changes) for a runnable draft and the supported steps.

## Native execution composition

Compose native workflow/entity execution layers in `ApplicationBun.run`'s `services`, with explicit `Layer.provide` of a private SQLite layer. There is no `execution` option. Native `background`, `routes`, `initialize`, and the worker command remain. The examples' [database helper](packages/example-support/src/databases.ts) checks opened file paths and inodes before native execution tables initialize; the framework does not supply a pre-open URL or dangling-symlink guard. Application and execution transactions remain separate. See the [durable runbooks](apps/README.md#durable-workflows).

## Run the reservation application

```bash
bun install
bun run build
bun run reservations:server
```

In another terminal:

```bash
bun run reservations stock.get --input-json '{"sku":"book"}'
bun run reservations reserve --input-json '{"sku":"book","quantity":2}'
bun run reservations reservations.get --help
```

The example is loopback-only and unauthenticated. Its [guide](apps/README.md#reservation-application) covers release, confirmation, configuration, and migration history. The [validation record](docs/wiki/validation-strategy.md#reservation-slice) separates exercised behavior from unresolved framework questions.

The authenticated [orders/invoices walkthrough](apps/README.md#orders-and-invoices) adds composite foreign keys, tenant-local uniqueness, managed secondary indexes, and explicit optimistic versions. Run `bun run orders-invoices:server`, then use `ORDERS_INVOICES_TOKEN=alice-demo bun run orders-invoices billing.createOrder --input-json '{"number":"SO-1","customer":"Example customer"}'` in another terminal. Mutations remain authored transactions; generated reads stay tenant-scoped.

The [example applications](apps/README.md) have persistent SQLite databases, HTTP servers, generated CLIs, and local inspection. Resource applications retain frozen migrations; native Effect manages durable execution history. Run `bun run <example>:server` and use `bun run <example> --help` in another terminal. [Todo rules](apps/resource-crud/resources.ts) demonstrate tenant/owner scope and completion locks; [note rules](apps/service-codec/resources.ts) demonstrate reader/editor/admin permissions alongside a storage codec. Their [demo credentials and walkthroughs](apps/README.md#demo-authentication) are deliberately public and loopback-only. Other examples cover minimal public CRUD, authored queries, explicit schema evolution, reservation policy, and native durable execution.

## Escape hatches and documentation

Authored SQL uses Effect's `SqlSchema` combinators for request encoding and result decoding, or explicit Schema encode/decode Effects when semantics differ. There is no framework `Query` wrapper, database-service alias, or persistent-reference cache. Authorization, transactions, caching, concurrency, and recovery policy remain application concerns. Workflow diagnostics use native Effect services directly in the [workflow application](apps/durable-workflows/workflow.ts).

- [Runnable applications](apps/README.md)
- [Project wiki](docs/wiki/README.md)
- [Tables and queries](docs/wiki/tables-and-queries.md)

## Documentation site

The VitePress site uses `docs/index.md` for the landing page, `docs/getting-started.md` for onboarding, and the maintained Markdown in `docs/wiki/` directly—no copied wiki content. Configuration and theme live in `docs/.vitepress/`. After `bun install`, run:

```bash
bun run docs:dev
bun run docs:build
bun run docs:preview
```

In the repository’s Pages settings, set **Source** to **GitHub Actions**. The [deployment workflow](.github/workflows/docs.yml) checks pull requests and publishes pushes to `main`; it also supports manual deployment from `main`. GitHub supplies the repository identifier and Pages base path, including project subdirectories and custom domains. To enable GitHub source links while developing locally, set the repository identifier:

```bash
GITHUB_REPOSITORY=owner/repo bun run docs:dev
```

Without `GITHUB_REPOSITORY`, source citations remain readable labels rather than links to an assumed repository. `DOCS_SOURCE_REF` overrides the source-link branch (default `main`). Use `DOCS_BASE=/effect-domains/` with both build and preview to check project-path hosting locally; otherwise local commands serve at `/`.

Wiki citations keep their repository-relative Markdown URLs. The website maps code citations to GitHub and adapts numeric heading anchors to VitePress. Immutable `docs/wiki/raw/` sources are rendered as plain Markdown, are excluded from search, and have no edit link. Maintainer instructions are not published as site pages.

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
