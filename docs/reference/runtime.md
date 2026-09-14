---
description: Bun runner options, environment variables, generated commands, HTTP endpoints, and client input formats.
---

# Runtime and clients

This reference covers `ApplicationBun.run` in the current Bun workspace. The [first-run tutorial](/getting-started) shows a complete invocation; [define a resource](/guides/define-a-resource) covers application setup.

## Application composition

```ts
import { Application, Part } from "effect-domains/application"
import { ReadingListResource } from "./resources.ts"

const application = Application.compile(Application.define({
  name: "reading-list",
  parts: [Part.resource(ReadingListResource)],
}))
```

This example belongs beside the reading list's `resources.ts`. In your application, import the resource you want to register.

Definitions accept explicit `Part.resource`, `Part.command`, `Part.native`, and `Part.application` values. `Application.compile` produces the authoritative `ApplicationIR`; adapters do not rediscover resources or inspect arbitrary object properties. Compilation rejects duplicate table and command names.

## Bun runner

Import `ApplicationBun` from `effect-domains/application-bun`. `ApplicationBun.run(application, options)` returns the command Effect; pass it to the re-exported `ApplicationBun.runMain` boundary in a Bun entrypoint.

| Option | Contract |
| --- | --- |
| `database.migrations` | Required ordered array of frozen SQLite migration artifacts, usually from `SqliteMigrations.history(...)`. |
| `database.filename` | Optional explicit filename; overrides the database environment variable. |
| `services` | Application service layer, built with the application SQL client available. Authentication and storage-codec services belong here. |
| `initialize` | Startup Effect, run after database preparation and service construction. |
| `background` | Background layer, built after initialization. Also enables the `worker` command. |
| `routes` | Additional native HTTP route layer for `serve`. |
| `admin` | Omitted by default. `true` enables the prebuilt admin; an object accepts `path`, `presentation`, and `allowedOrigins`. |
| `telemetry` | Automatic OTLP tracing when an endpoint is configured. An object configures export; `false` opts out of the runtime exporter. |

For `serve` and `worker`, startup prepares the database, builds `services`, runs `initialize`, and then starts `background`. `serve` additionally starts HTTP. Initialization therefore also runs in worker mode; it must be appropriate for each process you launch.

## Environment variables

The prefix comes from `application.name`: uppercase, with each non-alphanumeric character replaced by `_`. For `reading-list`, the prefix is `READING_LIST`.

| Variable | Used by | Default |
| --- | --- | --- |
| `PORT` | Server | `3000` |
| `<PREFIX>_DB` | Server / worker, unless `database.filename` is set | `data/<application-name>.sqlite` |
| `<PREFIX>_URL` | Remote CLI | `http://127.0.0.1:3000/rpc/v1` |
| `<PREFIX>_TOKEN` | Remote CLI | Absent; when set, sent as a bearer token |
| `<PREFIX>_IDENTITY_DB` | `SqliteIdentity.layer` | `data/<application-name>-identity.sqlite` |
| `<PREFIX>_EXECUTION_DB` | `SqliteBunRuntime.privateClient({ purpose: "execution" })` | `data/<application-name>-execution.sqlite` |
| `EFFECT_CLUSTER_MODE` | Durable server / worker | `single`; accepts `single`, `runner`, or `client` |
| `EFFECT_CLUSTER_HOST` | Advertised HTTP runner address | `127.0.0.1` |
| `EFFECT_CLUSTER_PORT` | Advertised HTTP runner address | `34431` |
| `EFFECT_CLUSTER_LISTEN_HOST` | HTTP runner listener | `EFFECT_CLUSTER_HOST` |
| `EFFECT_CLUSTER_LISTEN_PORT` | HTTP runner listener | `EFFECT_CLUSTER_PORT` |
| `EFFECT_DOMAINS_DEMO_PASSWORD` | Example account bootstrap | Required; no fallback |
| `EFFECT_DOMAINS_SESSION_LIFETIME` | Example issued-session lifetime | `8 hours`; must be positive and finite |

`SqliteBunRuntime.privateClient({ application, purpose, filename? })` uses the corresponding `<PREFIX>_<PURPOSE>_DB` variable unless `filename` is supplied, creates its parent directory, and refuses the application database file or inode. `SqliteIdentity.layer` uses it with `purpose: "identity"`. Durable examples use it with `purpose: "execution"`; do not point either private store at the application database.

`PORT` does **not** change the client URL. Example, in separate terminals:

```bash
# Server
PORT=3001 READING_LIST_DB=reading-list-local.sqlite bun run reading-list:server
```

```bash
# Client
READING_LIST_URL=http://127.0.0.1:3001/rpc/v1 bun run reading-list books.list
```

The Bun runner binds to `127.0.0.1`. It does not provide a configurable public bind address or a production deployment setup.

## OpenTelemetry tracing

RPC tracing requires no handler wrappers or domain annotations. The runner installs Effect's native OTLP tracer around the entire command lifetime: HTTP RPC, generated CLI calls, in-process admin/MCP RPCs, initialization, and workers. Existing Effect and SQL spans participate in the same traces. Finished spans are batched and flushed on graceful shutdown, including short-lived CLI commands.

Export starts automatically when `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set:

```bash
bun run reading-list:server:otel
```

That sets `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`. Use `bun run reading-list:otel …` for the matching CLI process so both sides of a trace export. With no endpoint, no collector is contacted and an externally supplied tracer is left intact.

The [reading-list walkthrough](../../examples/reading-list/README.md#opentelemetry-traces) searches Jaeger service `reading-list` at [http://127.0.0.1:16686](http://127.0.0.1:16686/).

For declarative configuration, add this option to `ApplicationBun.run`:

```ts
telemetry: {
  endpoint: "https://collector.example.com/v1/traces",
  protocol: "http/protobuf",
  resource: {
    serviceName: "reading-list",
    serviceVersion: "1.2.0",
    attributes: { "deployment.environment.name": "production" },
  },
  exportInterval: "5 seconds",
  maxBatchSize: 1000,
  shutdownTimeout: "3 seconds",
},
```

| Option | Contract |
| --- | --- |
| `endpoint` | Full OTLP traces URL, used unchanged. The generic environment endpoint instead appends `/v1/traces`. |
| `protocol` | `http/protobuf` (default) or `http/json`. No gRPC transport. |
| `resource.serviceName` | Explicit service identity; otherwise `OTEL_SERVICE_NAME`, then `service.name` in `OTEL_RESOURCE_ATTRIBUTES`, then `application.name`. |
| `resource.serviceVersion` | Optional service version. |
| `resource.attributes` | Static resource metadata. Explicit resource fields override matching attributes; explicit attributes override environment metadata. |
| `headers` | Native Effect HTTP headers for collector authentication. These are exporter headers, not RPC credentials. Prefer deployment-provided secrets. |
| `exportInterval` | Effect duration input; defaults to 5 seconds. |
| `maxBatchSize` | Number of buffered spans triggering an export; defaults to 1000. Not a bounded queue or total-memory limit. |
| `shutdownTimeout` | Effect duration input limiting graceful exporter shutdown; defaults to 3 seconds. |

Explicit options override environment configuration. Otherwise the native exporter honors `OTEL_EXPORTER_OTLP_TRACES_*` ahead of corresponding generic `OTEL_EXPORTER_OTLP_*` settings for endpoint, headers, protocol, and timeout. Resource metadata also accepts `OTEL_SERVICE_VERSION` and `OTEL_RESOURCE_ATTRIBUTES`. Batching accepts `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`, and `OTEL_BSP_EXPORT_TIMEOUT`; environment durations are milliseconds. Shutdown timeout precedence is traces timeout, generic timeout, then BSP export timeout.

`telemetry: false`, `OTEL_SDK_DISABLED=true`, or `OTEL_TRACES_EXPORTER=none` disables this exporter. Otherwise `OTEL_TRACES_EXPORTER` defaults to `otlp`. Opt-out does not disable native span creation or an independently installed tracer.

Native RPC trace propagation and parent sampling decisions remain authoritative; this integration does not add a second RPC span, sampler, metrics exporter, or log exporter. It does not add payload/result attributes. Native HTTP/SQL instrumentation and exception events can still contain sensitive data: treat the collector as trusted and apply application/collector redaction policy.

For a custom runtime or independently composed RPC adapter, import `ApplicationTelemetry` from `effect-domains/application-telemetry` and provide `ApplicationTelemetry.layer({ name }, options)` around the runtime. Supply its native `HttpClient` requirement with your platform's HTTP client layer. For a custom tracer implementation, opt out of the automatic exporter and provide the native tracing layer yourself.

## Local commands

| Command | Behavior |
| --- | --- |
| `--help` | Lists commands. An operation’s `--help` describes its CLI usage. |
| `serve` | Starts HTTP RPC, MCP, and any configured admin/routes. |
| `inspect` | Prints application contracts and metadata as JSON. |
| `inspect <operation>` | Restricts inspection to one operation. |
| `worker` | Runs the application runtime without HTTP. Available only when `background` is configured. |

Help and inspection do not need a running server. Inspection does not execute handlers or prove that a database matches the declared schema.

## Identity services and RPC

`effect-domains/identity` is the portable identity boundary. It exports `CredentialsSchema`, `IssuedSessionSchema`, `CurrentSessionSchema`, `SubjectSchema`, `IdentityUnavailable`, and the narrow `IdentityRuntime` service. `IdentityRuntime` verifies credentials, authenticates an opaque token into a session ID, expiry, and current subject, and revokes a session ID.

`effect-domains/identity-rpc` is the native RPC adapter. `IdentityBundle` packages its `IdentityRpcs` group and `IdentityHandlers` layer for `Application.parts`, publishing `identity.login`, `identity.current`, and `identity.logout`. `authenticateIdentity(headers)` parses and verifies a bearer credential; `current` and `logout` authenticate every call. Their failures are `Unauthenticated` and `IdentityUnavailable`.

`SqliteIdentity.layer({ application, accounts, password, sessionLifetime?, filename? })` supplies `IdentityRuntime` and the narrower `AuthorizationRpc.Authenticator`. Its identity database is private to the named application. An application can instead provide a verified custom IdP adapter to `AuthorizationRpc.Authenticator`.

The examples wrap that factory in `ExampleIdentity.layer(application)`, with seeded demonstration accounts. It is example bootstrap data, not a production user-management system or IdP.

The CLI uses the normal `<APP>_URL` and `<APP>_TOKEN` variables. `identity.login` returns canonical JSON containing a secret token, ISO `expiresAt`, and subject; handle the token as a secret. `identity.current` returns the expiry and subject, and `identity.logout` revokes the presented credential.

```bash
bun run team-tasks identity.login --input-json '{"username":"alice","password":"…"}'
```

Use `--input-json`, not `--input`. When a password comes from an environment variable, construct the payload with `JSON.stringify` rather than shell interpolation. A captured login result can be reduced to the token with:

```bash
bun -e 'console.log(JSON.parse(await Bun.stdin.text()).token)'
```

## Remote CLI operations

```bash
bun run reading-list books.create --input-json '{"title":"A Wizard of Earthsea","author":"Ursula K. Le Guin","status":"planned","format":"paperback"}'
```

- Input is a single canonical JSON value through `--input-json`, not one flag per field.
- Use JSON numbers and booleans, not quoted substitutes.
- An empty struct or an all-optional object payload defaults to `{}` when input is omitted. No-payload operations also need no input.
- Required payload fields must be supplied. Creation defaults are specific to that operation.
- Success is JSON on stdout. Input, transport, authorization, and declared operation failures exit nonzero.
- Input and result codecs follow the RPC contract, not storage encodings. Encrypted storage values do not belong in CLI input.

## HTTP endpoints

| Path | Protocol | Availability |
| --- | --- | --- |
| `/rpc/v1` | Effect HTTP RPC with JSON serialization | Every `serve` command |
| `/mcp` | Streamable HTTP MCP | Every `serve` command |
| `/admin` | Browser administration | Only when enabled; path is configurable |

`/rpc/v1` is not a REST resource API. Use the generated CLI or native Effect `RpcClient`.

### MCP tools

Each published RPC operation becomes a tool. Arguments wrap the canonical payload:

```json
{
  "input": {
    "filter": { "status": "planned" },
    "limit": 10
  }
}
```

Successful structured content is `{ "result": <operation result> }`, also returned as JSON text; void results become `null`. Declared failures return `isError: true` with the encoded error.

No-payload identity tools still require the MCP wrapper: call `identity.current` and `identity.logout` with `{ "input": null }`. Read the issued token from `identity.login`'s structured content at `result.token`.

Protected tools require bearer credentials on every call. Tool discovery exposes contracts, not authorization to read protected rows. The [equipment example](/examples#equipment-register) includes an SDK client.

### Example Foldkit clients

Each example page is a contract-bound native `RpcClient` for the application's existing resource and native groups. `RpcBrowser` owns the lazy same-origin `/rpc/v1` protocol, native `FetchHttpClient` and JSON serialization layers, bearer request options, and display error formatting. `RpcBrowser.query` turns a model dependency record and Effect into a Foldkit subscription that runs initially and whenever its declared reactivity keys are invalidated. `RpcBrowser.mutation` runs an authored command and invalidates its declared keys only after success. `BrowserRuntime.run` injects the required root container and one shared native `Reactivity` service while constructing and starting Foldkit. `StaticSpa.layerHttp({ title, accent, base })` validates the site declaration and serves its explicitly prebuilt JavaScript and CSS.

The client modules stay narrow:

- `Requests` owns keyed monotonic request tokens, per-key pending/error state, session epochs, key-specific invalidation, and guarded settlement for imperative requests.
- `Page` owns the shared `{ items, nextCursor }` value plus explicit replace/append and cursor input helpers.
- `ResourcePager.make(key)` composes those two concerns for explicit continuation starts and stale-page rejection.
- `Form` decodes strict integers, finite numbers, and nullable trimmed text into existing schemas and maps schema issues to field paths.
- `IdentitySession` owns in-memory login/logout/expiry commands and generation changes. Credentials are never rendered or stored; the example-web package supplies only the styled session view.
- `ResourceEditor.make` derives a public CRUD editor only when `list`, `create`, `update`, and `remove` are all published. Its base list is a reactive subscription keyed by the exact Resource descriptor, and successful save/remove commands invalidate that descriptor so the list refetches without reducer reload commands. Form codecs, copy, error display, and complete presentation remain authored.

Field Notes exercises the authored seam: session, filter, and manual-refresh changes restart its declared base-list subscription; save/remove mutations invalidate `FieldReportsResource`; and **Load more** remains an explicit cursor command. Editorial Calendar exercises the derived `ResourceEditor` path. Applications still own authorization, filter dependencies, continuation policy, reactivity-key selection for authored operations, and business state transitions.

This is browser-local invalidation and refetch over ordinary unary `/rpc/v1` requests. It does not provide server push, cross-tab notification, WebSocket/SSE transport, or offline synchronization; changes made by another client become visible on an explicit refresh unless an application supplies an external invalidation source. [`packages/example-web`](../../packages/example-web/) contains build and HTML presentation support, not RPC, paging, identity, runtime, or static-serving mechanics.

### Browser admin

Run `bun run build` before starting an admin-enabled server. Runtime loads prebuilt JavaScript and CSS; it does not compile the browser application on startup.

The interface provides operation forms, resource lists, declared filters, cursor paging, and a full-JSON input fallback. It uses the same handlers and authorization as other clients. Tokens entered in the UI remain in browser memory.

The generated admin is a generic bearer-entry surface: it accepts a real issued credential and does not bypass authentication. It uses the same per-call identity verification as RPC, CLI, MCP, and operator metrics; an MCP transport session is not an identity.

`allowedOrigins` names exact origins permitted by the admin’s origin check when using a non-loopback host. It is not a CORS configuration, authentication policy, or permission grant.

## Durable execution

The runner composes native Effect layers; the framework does not supply a job system. `@effect-domains/example-support/cluster-runtime` is the version-sensitive native integration boundary used by the report and reminder examples. The Effect and platform packages are pinned to the same exact release candidate.

`EFFECT_CLUSTER_MODE` selects `single` (default local runner), `runner` (Bun HTTP runner), or `client` (client-only sharding). Runner address/listen settings use `EFFECT_CLUSTER_HOST`, `EFFECT_CLUSTER_PORT`, `EFFECT_CLUSTER_LISTEN_HOST`, and `EFFECT_CLUSTER_LISTEN_PORT`. Multiple runners are supported only as colocated processes sharing the same execution SQLite file; this does not claim cross-host SQLite distribution. `clusterWorkerLayer` prevents client-only application servers from installing runner registrations while still allowing application-owned relay processes.

Every runtime startup compares application topology version, shard count, and sorted shard groups against metadata in the execution store before background work begins. Same-topology binaries can roll one runner at a time. Mixed topology versions are rejected.

### Change durable topology

A topology or native execution-store compatibility change requires a maintenance window:

1. Stop every client and runner.
2. Back up the application database, execution database, and external artifacts or projections as one recovery set.
3. Apply the migration supported by the pinned native Effect version when its execution schema changes.
4. Update the application's `clusterRuntimeLayer(application, topologyVersion)` call and prepare a one-use deployment Effect with the same new version, shard count, and sorted groups.
5. Run the compare-and-set against the execution database. It succeeds only when `fromVersion` is still current and `toVersion` is greater.
6. Start one upgraded runner. Verify report runner health through `ReportExport.Status`, or exercise one scheduled reminder for the reminder application.
7. Start the remaining runners and clients, then remove the one-use deployment file.

For example, save the following as `.tmp/upgrade-report-cluster.ts` while upgrading report exports from topology 1 to 2:

```ts
import { Config, Effect, pipe } from "effect"
import { advanceClusterTopology } from "@effect-domains/example-support/cluster-runtime"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"

const upgrade = Effect.gen(function* () {
  const filename = yield* Config.string("REPORT_EXPORTS_EXECUTION_DB")
  const database = SqliteBunRuntime.sqlClient(filename, { migrations: [] })

  yield* pipe(
    advanceClusterTopology({
      application: "report-exports",
      fromVersion: 1,
      toVersion: 2,
      shardsPerGroup: 64,
      shardGroups: ["default"],
    }),
    Effect.provide(database),
    Effect.scoped,
  )
})

await Effect.runPromise(upgrade)
```

Run it once with the same explicit execution file used by the stopped deployment:

```bash
REPORT_EXPORTS_EXECUTION_DB="$PWD/data/report-exports-execution.sqlite" \
  bun run .tmp/upgrade-report-cluster.ts
```

Do not rerun it with altered expectations, start version 2 code before it succeeds, or use it as a general migration mechanism. Appointment reminders use `application: "appointment-reminders"` and `APPOINTMENT_REMINDERS_EXECUTION_DB`; their runtime call must advance to the same `toVersion`.

Report acceptance is an application-database transaction that writes an execution/outbox row. A scoped relay dispatches it at least once to native workflow storage using a deterministic ID. Recoverable infrastructure defects suspend, and an authorized resume continues the same execution. Cancellation is explicit and cannot race past the artifact-writing transition. The artifact sink is immutable and idempotent; reconciliation recreates missing bytes and rejects different bytes. These bounded guarantees do not create a cross-database transaction or general exactly-once delivery.

The Field Notes synchronization slice uses a native SQL `EventJournal`, typed `EventLog` events, remote replay, and a SQL projection. Concurrent edits converge by the authored `(revision, replicaId)` maximum; journal timestamps only identify native conflicts. Projection rebuild replays the persisted journal. EventLog remains an application-level policy seam. Browser refetch is instead a framework client mechanic keyed by explicit Resource descriptors; neither concern becomes canonical Resource metadata.

## Sources

- [Bun runtime](../../packages/effect-domains/src/application-bun.ts)
- [Application composition](../../packages/effect-domains/src/application.ts)
- [Telemetry configuration](../../packages/effect-domains/src/application-telemetry.ts)
- [CLI adapter](../../packages/effect-domains/src/rpc-cli.ts)
- [MCP adapter](../../packages/effect-domains/src/rpc-mcp.ts)
- [Admin adapter](../../packages/effect-domains/src/application-admin.ts)
- [Portable identity interface](../../packages/effect-domains/src/identity.ts)
- [Native identity RPC adapter](../../packages/effect-domains/src/identity-rpc.ts)
- [SQLite identity implementation](../../packages/effect-domains/src/sqlite-identity.ts)
- [SQLite Bun runtime](../../packages/effect-domains/src/sqlite-bun.ts)
- [Browser RPC boundary](../../packages/effect-domains/src/rpc-browser.ts)
- [Browser runtime](../../packages/effect-domains/src/browser-runtime.ts)
- [Identity session controller](../../packages/effect-domains/src/identity-session.ts)
- [Static SPA routes](../../packages/effect-domains/src/static-spa.ts)
- [Example HTML presentation](../../packages/example-web/src/)
- [Native Cluster runtime boundary](../../packages/example-support/src/cluster-runtime.ts)
- [Report execution outbox](../../examples/report-exports/executions.ts)
- [Field Notes EventLog synchronization](../../examples/field-notes/sync.ts)
- [Browser reactivity regression](../../test/RpcBrowserReactivity.test.ts)
