# Validation Strategy

## Goal

Test Effect Domains through complete vertical slices that expose the difference between domain behavior, storage, and transport. A schema demonstration alone cannot establish useful conventions. ([Project thesis](raw/project-thesis.md))

## Required Shape of a Slice

Each materially different slice should include branded values, a meaningful transition, typed business failures, database and wire representations, explicit transformations where semantics differ, and historical migration. Record removed duplication, change propagation, annotation cost, runtime boundaries, escape hatches, and clarity against handwritten adapters. ([Project thesis](raw/project-thesis.md); [Declarative interface direction](raw/effect-and-declarative-interface-direction.md))

## Evidence Standard

Link implementation and regressions, distinguish authored policy from generated machinery, and date live observations. A successful scenario establishes only its exercised contract. Historical verification is retained as historical evidence when the interface changes. This reporting rule is wiki analysis based on the thesis evaluation criteria.

## Reservation Slice

The [reservation application](../../examples/reservations/README.md) has branded SKU and reservation identifiers, positive quantities, and explicit `held → confirmed | released` transitions. Canonical models contain no transport or persistence mapping annotations beyond intrinsic identity. ([Domain](../../examples/reservations/domain.ts))

| Concern | Implementation |
| --- | --- |
| Models and policy | Canonical schemas, reserve/confirm/release contracts, transitions, guarded stock accounting, and transactions are authored |
| Storage | Resource tables, recognized constraints, and reversible codecs are generated |
| Publication | Only selected resource reads are published; reservation mutations remain business commands |
| HTTP, CLI, and MCP | Application groups provide RPC dispatch, native flags, JSON fallback, and derived MCP tools |
| History | Frozen artifacts preserve historical schema and explicit timestamp conversion |

Sources: [resources](../../examples/reservations/resources.ts), [application](../../examples/reservations/application.ts), [contracts](../../examples/reservations/contracts.ts), [policy](../../examples/reservations/sqlite.ts), [migration fixture](../../examples/reservations/migrations.ts), and [runtime](../../src/application-bun.ts).

The slice removes duplicate storage schemas, ordinary read/query plumbing, initial DDL, and per-operation HTTP/CLI binding; stock effects and transaction boundaries remain authored. It is an SQLite-only result, and native flags are not evidence that generated CLIs replace domain-specific CLI design. ([Reservation regressions](../../test/Reservations.test.ts); [CLI regressions](../../test/RpcCli.test.ts))

## Verification Record

### 2026-09-09: MCP runtime derivation

The `serve` command derived by `ApplicationBun.run` now mounts `/mcp` beside `/rpc/v1`; applications do not redeclare tools. Native Effect MCP handles HTTP/session negotiation, while `RpcMcp` derives tool schemas and dispatches through the existing RPC handlers and middleware. ([Adapter](../../src/rpc-mcp.ts); [Runtime](../../src/application-bun.ts); [Usage](../../examples/README.md#mcp-server))

- `bun run check`, `bun run lint`, and all 36 tests across 13 files pass without suppressions or exclusions.
- HTTP-boundary regressions exercise discovery, Date input/output and tagged-error encoding, array/void results, invalid inputs, defect redaction, and service-dependent wire codecs. A type assertion preserves missing codec services as caller requirements. ([MCP regressions](../../test/RpcMcp.test.ts))
- Concurrent calls sharing one MCP session resolve separate Alice/Bob identities. Anonymous requests before and after authenticated calls, and a server without an authenticator, cannot inherit captured identity. These checks exercise native HTTP requests and RPC middleware rather than direct tool-handler mocks.
- Real Bun example servers with isolated in-memory SQLite exercised initialization, discovery, book create/get/update/list/remove, and missing-row errors. Protected notes rejected anonymous access, allowed editor creation and reader retrieval, denied a reader update without changing the row, and allowed administrator removal. Canonical note text traversed the existing service-dependent storage codec. The unchanged generated RPC CLI still returned the book list.
- Smoke servers were stopped afterward; their SQLite databases were in memory, and no temporary scripts were retained.

This verifies derived HTTP tools, not stdio, inferred MCP resources/prompts, REST, production credential issuance, or external desktop-client interoperability. Tool discovery is public metadata; authorization is enforced on calls.

### 2026-09-09: Authorized examples

The todo and service-codec applications now use authored resource policies and a shared demo-token authenticator. The other five examples remain explicitly public. These fixtures demonstrate the existing authorization API rather than adding framework behavior. ([Todo policy](../../examples/resource-crud/resources.ts); [Note policy](../../examples/service-codec/resources.ts); [Demo authenticator](../../examples/authentication.ts); [Walkthroughs](../../examples/README.md#demo-authentication))

- `bun run check`, `bun run lint`, and all 34 tests across 12 files pass. The existing codec regression now supplies an authorized subject for its protected note creation. No suppressions or new test scaffolding were added. ([Codec regression](../../test/ResourceCrud.test.ts))
- Real Bun example servers and their generated CLIs rejected missing/unknown credentials; isolated owner and tenant rows; and traversed Alice's three visible todos in one-item cursor pages while excluding interleaved rows. Forged owner/tenant creates and ownership transfers failed. Owners could edit incomplete todos, but not completed ones; denied edits and removals preserved state. An administrator reopened and removed a todo, and the owner could edit again after reopening.
- The note CLI allowed editor create/update and reader reads, denied reader writes and editor deletion, and allowed administrator deletion. Another tenant's editor could read the intentionally global collection. RPC returned canonical `Revised domain text`; direct SQLite inspection showed `stored:Revised domain text`.
- An isolated database was prepared using the original todo migration and seeded with one old-format row. Normal example startup applied `002_ownership`, retained the row, and filled `tenantId = "acme"` and `ownerId = "alice"`. The existing CLI supports one backfill and one transform flag; generation therefore supplied an explicit tenant backfill and constant owner SQL expression. Restart retained both migrated and newly created rows. ([Ownership artifact](../../examples/resource-crud/migrations/002_ownership.json); [Manifest](../../examples/resource-crud/migrations/manifest.json))
- Both local `inspect` commands exposed subject schemas and rendered action policies without credentials. Both smoke servers were stopped and isolated SQLite files removed afterward.

The session tokens are public fixtures without login, expiry, or revocation. Production identity lifecycle, arbitrary authored SQL authorization, other databases, and distributed coordination remain outside this evidence.

### 2026-09-08: Resource authorization

The user-approved resource policy DSL requires explicit public, deny, or typed authorization. Canonical schemas remain authorization-free. One closed schema-backed AST and fold support evaluation, SQL visibility, reference validation, and inspection; request-local authenticated subjects reach protected generated RPCs. ([Authorization](../../src/authorization.ts); [Policy](../../src/policy.ts); [RPC authentication](../../src/authorization-rpc.ts))

- `bun run check` and `bun run lint` pass without suppressions or exclusions. All 34 tests across 12 files pass. Policy regressions cover SQL/evaluator parity, nulls and hostile values, lazy evaluation, tenant/owner/admin visibility, pagination, denied mutation rollback, unreadable candidates, concurrent ownership changes, unsupported Boolean SQL encoding, and RPC identity isolation. Type checks cover missing authorization, incompatible operand types, and invalid policy phases. ([Policy regressions](../../test/Policy.test.ts); [authorization regressions](../../test/Authorization.test.ts); [RPC regressions](../../test/AuthorizationRpc.test.ts); [type boundaries](../../test/Authorization.types.ts))
- A real Bun HTTP server and generated CLI used isolated in-memory SQLite and an authored test-session authenticator. Missing credentials yielded `Unauthenticated`; another owner's row and another tenant's row yielded `ResourceNotFound`. Two one-item cursor pages returned only the caller's documents.
- Live CLI mutations rejected ownership transfer without changing the original owner, accepted an allowed title patch and owned create/remove, and reported the removed row missing. A forged-owner create failed with `Forbidden` and left no row. The smoke server was stopped; temporary helpers were removed.

This establishes the exercised SQLite resource and request-identity boundary, not production credential issuance/revocation, authorization of arbitrary authored SQL, another database, or another business-policy domain. ([Resource](../../src/resource.ts); [SQLite adapter](../../src/sqlite-bun.ts); [Bun runner](../../src/application-bun.ts))

### 2026-09-08: CRUD and JSON codec simplification

The user-approved change makes basic book CRUD a generated resource declaration and moves custom book contracts and SQL to `authored-sql`. Both use the same canonical `BookSchema`; the authored example retains its custom errors and deleted-row remove result. `Commands.rpc(tag, { payload, success, error })` derives JSON codecs and returns a native RPC, replacing wire-schema declarations in authored books, counters, and reservations without a second contract format. ([Basic resource](../../examples/basic-crud/resources.ts); [Authored contracts](../../examples/authored-sql/contracts.ts); [Commands](../../src/commands.ts))

- `bun run check` and `bun run lint` pass without suppressions. All 25 tests across nine files pass. The added regression exercises Date payload/success and tagged-error JSON codecs. ([Command regressions](../../test/Commands.test.ts); [Tests](../../test/))
- Real Bun HTTP servers with isolated in-memory SQLite databases exercised both book applications through their generated CLIs: create, get, list, update, remove, and a missing-row failure. Basic CRUD generated UUIDv7 identifiers, returned `void` on removal, and reported `ResourceNotFound`; authored SQL returned the deleted row and reported `BookNotFound`. Both local `inspect books.create` commands selected the expected contract without connecting to a server. ([Basic entrypoint](../../examples/basic-crud/main.ts); [Authored entrypoint](../../examples/authored-sql/main.ts))
- The migrated counter RPCs exercised get, increment, set, a stale cached get, and refresh. Reservation RPCs exercised reserve, release, confirm, `InvalidReservationState`, and stock accounting; timestamp values remained ISO strings over JSON. All smoke servers were stopped, and no smoke files or databases were retained. ([Counter entrypoint](../../examples/persisted-ref/main.ts); [Reservation entrypoint](../../examples/reservations/main.ts))

These checks cover the listed unary JSON contracts. They do not establish streaming support, authenticated middleware, another database, or another business-policy domain.

### 2026-09-08: Native RPC contract verification

The preceding user-approved cutover replaced custom input/output/error records with native `Rpc.make` and `RpcGroup.make` declarations. `Commands.make({ name, group })` retained the supplied group and injectable unary service behavior. JSON codec derivation was explicit at this stage; the later simplification above moves that work into `Commands.rpc`. Links point to the current authored-book location. ([Commands](../../src/commands.ts); [Book RPCs](../../examples/authored-sql/contracts.ts); [Reservation RPCs](../../examples/reservations/contracts.ts); [Counter RPCs](../../examples/persisted-ref/contracts.ts))

- `bun run check` and `bun run lint` pass without suppressions. All 24 tests in nine files pass, including captured handler dependencies and invocation-context precedence. ([Command regression](../../test/Commands.test.ts); [Tests](../../test/))
- Real Bun HTTP servers with isolated in-memory SQLite databases exercised all three migrated applications through their generated CLIs: book create/get/list/update/remove and `BookNotFound`; counter get/increment/set, a stale cached read, and refresh; reservation reserve/release/confirm, `InvalidReservationState`, and stock accounting. Reservation timestamps remained ISO strings over JSON. Local `inspect books.create` selected the native RPC contract. The servers were stopped afterward; no smoke files or databases were retained. The authored book entrypoint has since moved from basic CRUD to authored SQL. ([Book entrypoint](../../examples/authored-sql/main.ts); [Counter entrypoint](../../examples/persisted-ref/main.ts); [Reservation entrypoint](../../examples/reservations/main.ts))

These checks establish the migrated unary contracts, not streaming RPC support, authentication middleware, or additional transports.

### 2026-09-08: Lint remediation verification

- `bun run lint` passes with no diagnostics; no exclusions or rule suppressions were added. `bun run check` passes, and all 24 tests in nine files pass. The cutover uses explicit construction records and runtime options, Effect-native operations, and schema-validated dynamic boundaries. Callers and documentation use the updated contracts. ([Lint configuration](../../better-typescript.json); [Application](../../src/application.ts); [Tests](../../test/))
- Isolated Bun HTTP servers exercised generated todo creation with defaults, nested boolean patch flags, filtered pagination, and removal. Local inspection emitted the selected schema and rejected an unknown operation. A service-dependent note creation returned canonical text while direct SQLite inspection showed `stored:Canonical smoke`. ([Todo entrypoint](../../examples/resource-crud/main.ts); [Note codec](../../examples/service-codec/storage.ts); [CLI](../../src/rpc-cli.ts))
- A disposable SQLite scenario exercised `PersistedRef.fromResource` with an already-decoded numeric codec input, an omitted default, an omitted generated value, bound-key persistence, and reuse of an existing row. The derived `createInputSchema` validates canonical creation input without reapplying codecs or requiring a complete row. The smoke script and databases were removed afterward. ([PersistedRef](../../src/persisted-ref.ts); [Resource](../../src/resource.ts))

These checks cover the listed paths; the broader six-application observations below remain historical evidence.

### 2026-09-08: Simplification verification

The user-approved cutover requires initial migration history, removes the framework Query wrapper in favor of Effect primitives, and preserves generated native CLI flags. Source size fell from 5,428 to 4,128 lines; the generic AST algebra, direct table-write service, database alias, opaque descriptor schema classes, and migration bootstrap/adoption state were removed. ([Table](../../src/table.ts); [Runtime](../../src/sqlite-bun.ts); [Migrations](../../src/sqlite-migrations.ts); [Authored SQL, current location](../../examples/authored-sql/sqlite.ts))

- All six applications started as real Bun HTTP servers against isolated SQLite files. Generated CLIs exercised authored book create/get/update/remove and missing-row errors; todo defaults, two cursor pages, nested patch flags, mixed-input rejection, and invalid-patch preservation; canonical note create/update; counter increment, cached reads, direct writes and refresh; and reservation hold/release stock accounting. Physical note storage contained `stored:revised` while RPC returned `revised`. ([Example guide](../../examples/README.md))
- The historical document seed upgraded to `heading`, retained its identifier, and gained `summary: null` and `priority: 0`. Restart retained the same row; the database contained two ledger entries and no separate schema-state table. Local `inspect todos.patch` emitted the selected operation. ([Document seed](../../examples/migration-lifecycle/seed-v1.ts); [Inspection](../../src/application-inspect.ts))
- A disposable command-only application exercised native string enums, numeric literals, boolean literals, finite positive/negative numeric flags, and present/absent optional nested fields. Invalid native enum values failed through Effect CLI's parser, which prints usage on stdout and the error on stderr; schema/business failures exercised above kept stdout empty. ([CLI interpreter](../../src/rpc-cli.ts))
- `bun run check` passed. All 24 tests in nine files passed, including migration rollback/registration/drift, missing initial history, cyclic scalar rejection, reservation transitions, and codec-service requirements. Obsolete Query/algebra tests and tests of wrapper metadata or void return plumbing were removed rather than repinned. ([Tests](../../test/))
- `bun run lint` did not pass. Its diagnostics include nested-call, declaration-spacing, optional-property, collection-style, and direct-control-flow restrictions; no rules were disabled. Passing tests and type checking do not imply lint compliance.

This verifies only the listed scenarios, not another database adapter or business domain.

### Earlier 2026-09-08 verification (pre-simplification)

The following was exercised against the preceding descriptor, resource, manifest, and single-runner APIs:

- All six applications ran through their actual CLI/server surfaces. Todo creation defaulted `completed` to `false`; patching nested resource input succeeded; generated identifier override was rejected; filtered listing selected completed rows; separate cursor traversal covered four rows, including equal titles, without duplicate identifiers; and restart retained data. A deterministic runtime `Value` service supplied an explicit generated identifier and timestamp, while caller overrides were rejected. ([Todo resource](../../examples/resource-crud/resources.ts); [Todo entrypoint](../../examples/resource-crud/main.ts); [Value](../../src/value.ts); [resource regressions](../../test/ResourceCrud.test.ts))
- The notes application returned canonical plain text over RPC while SQLite stored its `stored:` form. The persisted counter accepted eight simultaneous increments, retained process-local cache after a direct write, then loaded the direct value through refresh and restart. This exercises local synchronization only. ([Note storage](../../examples/service-codec/storage.ts); [Counter implementation](../../examples/persisted-ref/sqlite.ts); [persisted-resource regression](../../test/PersistedResource.test.ts))
- Reservation reserve/release succeeded; confirming a released reservation returned `InvalidReservationState` with nonzero stderr. The authored book application created, read, and listed rows through SQL. ([Reservation policy](../../examples/reservations/sqlite.ts); [Book SQL, current location](../../examples/authored-sql/sqlite.ts))
- The historical document application preserved existing identifier and title while upgrading it to `heading`, retained nullable `summary`, and backfilled `priority: 0`. A real migration runner generated an initial manifest artifact, preserved an existing row, rejected a required `priority` change with its exact blocked reason and no registry change, then generated `--backfill documents:priority:7`; the next server loaded that manifest and preserved the original identifier/title with priority `7`. The ledger contained `001_initial` and `002_priority`. ([Document entrypoint](../../examples/migration-lifecycle/main.ts); [migration fixture](../../examples/migration-lifecycle/migrations.ts); [migration regressions](../../test/SqliteMigrations.test.ts))
- `inspect todos.create` worked with an invalid remote URL because inspection is local; an unknown operation failed. Inspection includes generated schemas and resource/storage policy rather than a generated interface. ([Inspection](../../src/application-inspect.ts); [Bun runtime](../../src/application-bun.ts))
- `bun run check` passed, and all 33 tests in 11 test files passed. An earlier `better-typescript@0.4.12` lint attempt crashed with `SIGSEGV` in `inflight_dedupe_map.markGetOrStart`; the final attempt completed with exit code 1 and 772 diagnostics across 30 files. Leading categories were nested-call restrictions, declaration spacing, Effect collection conventions, and optional-property restrictions. Lint is not counted as passing verification; no rules were disabled.

This is evidence for the listed SQLite/application paths. It does not validate another database adapter or a second materially different business-policy slice.

### Historical verification (pre-2026-09-08 API)

Earlier evidence recorded a fresh-database scalar-field propagation experiment, 28 passing repository tests, five supporting persistent applications, and ten concurrent counter increments. It covered older command-record/application composition and historical example entrypoints; retain it as historical context, not a claim about the current `Commands` descriptors, manifest loading, or `ApplicationBun.run` contract.

That historical work observed generated todo CRUD, authored book queries, service-dependent note codecs, persisted counter refresh, and historical document rename/backfill. It also exercised reservation no-oversell, rollback, terminal transitions, and timestamp replay. The linked sources remain useful for the underlying behavior: [reservation regressions](../../test/Reservations.test.ts), [table regressions](../../test/Table.test.ts), [SQLite migration regressions](../../test/SqliteMigrations.test.ts), and [example guide](../../examples/README.md).

## Evidence Boundary

The todo and note examples authenticate public demo sessions; the other five examples remain public. All are loopback-only, not production deployment templates. Evidence does not establish production identity issuance/revocation, multi-process coordination, idempotent reservation creation, cancellation recovery, another database, relationships, or a materially different business domain. An external write can supersede a persisted reference unless the application defines a concurrency policy; refresh alone is not one. ([Example verification](#2026-09-09-authorized-examples); [PersistedRef](../../src/persisted-ref.ts); [Research agenda](research-agenda.md))

The next architectural evidence should be another material slice rather than further generalization around the reservation application.
