---
description: Bun runner options, environment variables, generated commands, HTTP endpoints, and client input formats.
---

# Runtime and clients

This reference covers `ApplicationBun.run` and the provider-neutral `ApplicationBun.runInfrastructure` path in the current Bun workspace. The [first-run tutorial](/getting-started) shows a complete invocation; [define a resource](/guides/define-a-resource) covers application setup.

## Application composition

```ts
import { Effect } from "effect"
import { Application, Part } from "effect-domains/application"
import { ReadingListResource } from "./resources.ts"

const application = Effect.runSync(Application.compile(Application.define({
  name: "reading-list",
  parts: [Part.resource(ReadingListResource)],
})))
```

This example belongs beside the reading list's `resources.ts`. In your application, import the resource you want to register.

Definitions accept explicit `Part.resource`, `Part.command`, `Part.native`, `Part.featureFlag`, and `Part.application` values. `Application.compile` returns an `Effect` whose success is the authoritative `ApplicationIR` and whose typed `ApplicationDefinitionError` reports invalid composition; adapters do not rediscover resources or inspect arbitrary object properties. Application modules execute that Effect explicitly at their composition boundary. Compilation rejects duplicate table, command, and feature-flag names.

Use `Part.application(child)` when a domain module owns a coherent set of resources and commands but the runnable application adds integrations such as identity. Compilation recursively flattens the child into the same `ApplicationIR`, so adapters and dependency validation see one operation, resource, command, and table set. [Orders and invoices](../../examples/orders-invoices/application.ts) exercises this boundary with a nested billing domain and an outer native identity bundle.

Sibling child applications may reference one another's exact Resource descriptors. Compilation gathers the full tree before validating foreign keys and command dependencies. [Support cases](../../examples/support-cases/application.ts) uses separate directory and case-management children: case relations and commands depend on resources registered by the directory sibling.

## Feature flags

Feature flags are application-level operational declarations, not fields on canonical domain schemas. Define each flag once, register its exact descriptor as an application part, and supply the runtime implementation through `services`:

```ts
import { Effect } from "effect"
import { Application, Part } from "effect-domains/application"
import { FeatureFlags } from "effect-domains/feature-flags"

const NewCheckout = FeatureFlags.define({
  name: "new-checkout",
  default: false,
  description: "Use the replacement checkout flow",
})

const application = Effect.runSync(Application.compile(Application.define({
  name: "storefront",
  parts: [Part.featureFlag(NewCheckout)],
})))

const services = FeatureFlags.layerMemory(
  application.featureFlags,
  [[NewCheckout, true]],
)

const program = Effect.gen(function* () {
  const enabled = yield* FeatureFlags.isEnabled(NewCheckout)
  yield* FeatureFlags.disable(NewCheckout)
  yield* FeatureFlags.enable(NewCheckout)
  const toggled = yield* FeatureFlags.toggle(NewCheckout)
  return { enabled, toggled }
})
```

`FeatureFlags.isEnabled`, `setEnabled`, `enable`, `disable`, and atomic `toggle` require the `FeatureFlags` service and fail with `FeatureFlagUnavailable` when the runtime does not manage the exact declared descriptor. `FeatureFlags.layerMemory(application.featureFlags, overrides?)` is the process-local implementation; its optional override entries pair an exact declaration with its initial Boolean state. It validates declarations and overrides in the layer's typed error channel during acquisition.

The memory layer resets on process restart. Persistent, remote, targeted, scheduled, or percentage rollout semantics require an application-provided `FeatureFlags` service implementation. The framework does not publish flag mutation RPCs or infer administrative authorization.


## Bun runner

Import `ApplicationBun` from `effect-domains/application-bun`. Use `ApplicationBun.run(application, options)` when the entrypoint intentionally owns runtime publications and migration configuration. Use `ApplicationBun.runInfrastructure(infrastructure, options)` when an `InfrastructureIR` is authoritative: it derives the application, migration history, RPC path, MCP path, UI path, and UI presentation from that graph. Both return the command Effect; pass it to the re-exported `ApplicationBun.runMain` boundary in a Bun entrypoint.

`runInfrastructure` accepts local runtime concerns without restating deployment intent: an optional database filename for a persistent store, services, initialization, background layers, native routes, and telemetry. It derives persistent storage from the normal `<PREFIX>_DB` configuration and uses `:memory:` for an ephemeral store; supplying a filename for an ephemeral declaration fails before command execution. It does not accept RPC, MCP, UI, or UI-asset overrides.

`ApplicationBun.run` accepts:

| Option | Contract |
| --- | --- |
| `database.migrations` | Required ordered array of frozen SQLite migration artifacts, usually from `SqliteMigrations.history(...)`. |
| `database.filename` | Optional explicit filename; overrides the database environment variable. |
| `services` | Application service layer, built with the application SQL client available. Authentication and storage-codec services belong here. |
| `initialize` | Startup Effect, run after database preparation and service construction. |
| `background` | Background layer, built after initialization. Also enables the `worker` command. |
| `routes` | Additional native HTTP route layer for `serve`. |
| `rpc` | Omit or `true` for HTTP RPC at `/rpc/v1`; `false` disables it; `{ path }` publishes it at a custom absolute path. |
| `mcp` | Omit or `true` for Streamable HTTP MCP at `/mcp`; `false` disables it; `{ path }` publishes it at a custom absolute path. |
| `ui` | Omitted or `false` disables the generated UI without loading its bundle; `true` enables it at `/`; an object accepts `path`, `presentation`, and `allowedOrigins`. |
| `telemetry` | Project-owned OTLP traces, metrics, logs, safe HTTP/RPC measurements, and optional browser ingestion. An object configures it; `false` opts out of every automatic telemetry layer. |

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

## Infrastructure and deployment

`effect-domains/infrastructure` is a closed provider-neutral deployment language. Resources declare stable IDs, dependencies, bindings, execution model, transaction semantics, writer topology, lifecycle, and publication intent. `InfrastructureCompiler.compile` rejects blank, padded, or duplicate names and IDs; dependency cycles; bindings to copied or unregistered descriptors; duplicate publication kinds; and collisions across RPC, MCP, and every route reserved by the generated UI. `InfrastructureInspect.describe` renders canonical JSON without handlers or credentials.

`ApplicationInfrastructure.define` is the convenience derivation for the common SQLite HTTP shape:

```ts
import { ApplicationInfrastructure } from "effect-domains/application-infrastructure"
import { InfrastructureCompiler } from "effect-domains/infrastructure-compiler"

export const ReadingListInfrastructureIR = InfrastructureCompiler.compile(
  ApplicationInfrastructure.define({
    application: ReadingListApplication,
    database: {
      migrations: ReadingListMigrations,
      transactions: "interactive",
      durability: "persistent",
      writerTopology: "single",
    },
    http: {
      rpc: true,
      mcp: true,
      ui: { presentation: { title: "Reading list" } },
      public: true,
    },
  }),
)
```

The same compiled value drives local execution without repeating application, migration, or publication settings:

```ts
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ReadingListInfrastructureIR } from "./infrastructure.ts"

const program = ApplicationBun.runInfrastructure(ReadingListInfrastructureIR, {
  telemetry: {
    resource: { serviceName: "reading-list" },
  },
})

pipe(program, ApplicationBun.runMain)
```

`@effect-domains/alchemy` supplies exhaustive backends over that graph. Railway maps it to a Project, one process Service, a mounted Volume, and a generated public domain. Fly maps it to an App, one process Service, a per-machine mounted Volume, and a shared public IPv4 assignment. Both run one process-scoped `ApplicationRuntime` with `SqliteNodeRuntime`, use the declared migration history at process startup, require the declared single-writer topology, and reject multi-writer graphs rather than weakening them to one replica. Railway accepts only `backups: "none"` because its provider resource cannot apply the declared schedule; Fly maps `none`, `daily`, and `weekly` to its volume snapshot settings. Both carry the same `reading-list/api`, `reading-list/application`, and `reading-list/public` logical identities. `RailwayInfrastructure.plan(...)` and `FlyInfrastructure.plan(...)` return the provider resource kinds, logical IDs, mount and database paths, handler, port, region, replicas, publications, and state mode without applying a stack.

An Alchemy entrypoint exports the generated runtime resource by the same name supplied as `handler`, then exports the stack:

```ts
import { RailwayInfrastructure } from "@effect-domains/alchemy/railway"
import { Effect } from "effect"
import { ReadingListInfrastructureIR } from "./infrastructure.ts"

const deployment = RailwayInfrastructure.make({
  infrastructure: ReadingListInfrastructureIR,
  options: {
    main: import.meta.url,
    handler: "Runtime",
  },
})

export const Runtime = Effect.fn("ReadingListRailway.Runtime")(function* () {
  return yield* deployment.runtime
})()

export default deployment.stack
```

Persistent resources default to retain-on-removal in the `production` Alchemy stage. Railway can retain the Volume independently. Fly volumes are embedded in the Service replica set, so the backend conservatively retains the App and Service together when production retention is required.

Both backends use Alchemy's local state store for non-production work unless `options.state` supplies another Alchemy `State` layer. A `production` stack fails before provider resources execute when the resolved state store is local; production therefore requires an explicitly supplied shared state implementation. This protects deployment coordination state, not application SQLite data or backups.

Backends validate capabilities before declaring provider resources. The current Cloudflare capability interpreter rejects the Reading List graph at `transactions:interactive`: D1's batch transaction model cannot preserve the application's interactive transaction contract. It does not silently weaken that contract.

The checked-in examples are [`alchemy.railway.ts`](../../examples/reading-list/alchemy.railway.ts) and [`alchemy.fly.ts`](../../examples/reading-list/alchemy.fly.ts). Current verification compiles their declarations, inspects both provider plans, and runs the declared Reading List HTTP/UI path with the packaged UI artifacts under a real Node 26 process and in-memory SQLite. It does not apply either stack to a cloud account. Credentials, regions, remote state provisioning, production backup restoration, rollout policy, and multi-region database semantics remain deployment-owned concerns.

## OpenTelemetry

`ApplicationBun.run` can install one scoped OTLP runtime for traces, metrics, and logs. It covers `serve`, remote CLI, inspection, initialization, background layers, and `worker`. The generated UI uses one persistent browser runtime and forwards selected signals through a same-origin gateway. Canonical schemas and operation contracts contain no telemetry annotations.

No endpoint means no runtime-owned exporter or browser gateway traffic. Independently supplied tracer, metric, and logger services remain usable. `telemetry: false` disables the exporter, automatic safe HTTP/RPC observation, browser gateway, and runtime metrics.

### Start the local stack

```bash
bun run observability:up
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:14318 bun run reading-list:server
```

The pinned stack exposes Grafana at [http://127.0.0.1:3001](http://127.0.0.1:3001/), Prometheus at `:9090`, Tempo at `:3200`, Loki at `:3100`, and Collector OTLP/HTTP at `:14318`. The dashboard links traces, logs, and metrics. Stop it with `bun run observability:down`; validate alert rules with `bun run observability:alerts:test`.

### Declarative options

```ts
telemetry: {
  endpoint: "https://collector.example.com",
  protocol: "http/protobuf",
  resource: {
    serviceName: "reading-list",
    serviceVersion: "1.2.0",
    attributes: { "deployment.environment.name": "production" },
  },
  headers: { authorization: "Bearer deployment-secret" },
  traces: {
    sampleRate: 0.25,
    exportInterval: "5 seconds",
    maxBatchSize: 1000,
    shutdownTimeout: "3 seconds",
  },
  metrics: {
    temporality: "cumulative",
    exportInterval: "5 seconds",
    shutdownTimeout: "3 seconds",
  },
  logs: {
    exportInterval: "5 seconds",
    maxBatchSize: 1000,
    shutdownTimeout: "3 seconds",
    mergeWithExisting: true,
  },
  browser: {
    ingestPath: "/otel",
    signals: { traces: true, metrics: true, logs: true },
    maxRequestBytes: 262144,
    requestsPerMinute: 120,
  },
},
```

The top-level `endpoint` is an OTLP base URL; the runtime appends `/v1/traces`, `/v1/metrics`, and `/v1/logs`. A signal-level `endpoint` is its full URL and is used unchanged. A signal-level `protocol` or `headers` overrides the top-level value. Set `traces`, `metrics`, `logs`, or `browser` to `false` to disable that part.

`protocol` is `http/protobuf` by default and also accepts `http/json`; gRPC is not an application exporter transport. Trace and browser sample rates are finite values from 0 through 1. Root decisions are random and parent decisions remain authoritative. Durations, batch sizes, gateway body limits, and rate limits must be positive. Invalid explicit configuration fails startup.

Metrics enable Effect fiber-runtime instruments only while metric export is active. Logs preserve the existing logger by default; `minimumLevel`, `excludeLogSpans`, and `mergeWithExisting` pass through the native logger contract. Resource identity is shared by all backend signals. The browser service defaults to `<service-name>-browser`.

### Environment precedence

Explicit options override environment configuration. Without explicit values, each signal uses its `OTEL_EXPORTER_OTLP_<SIGNAL>_*` value before the generic `OTEL_EXPORTER_OTLP_*` value. A generic endpoint enables all three signals and appends their standard paths; a lone signal-specific endpoint enables only that signal.

Supported standard controls include:

- `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`, and `OTEL_EXPORTER_OTLP_HEADERS`
- signal-specific `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_{ENDPOINT,PROTOCOL,HEADERS,TIMEOUT}`
- `OTEL_{TRACES,METRICS,LOGS}_EXPORTER`; a value without `otlp`, including `none`, disables that signal
- `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION`, and `OTEL_RESOURCE_ATTRIBUTES`
- native batching controls `OTEL_BSP_*`, `OTEL_METRIC_EXPORT_*`, and `OTEL_BLRP_*`
- `OTEL_SDK_DISABLED=true`, which disables native OTLP construction

Environment durations use the native OpenTelemetry millisecond representation. Signal-specific headers are merged with explicit headers, with explicit values winning.

### Automatic measurements

The runtime emits these histograms in seconds with boundaries `0.005`, `0.01`, `0.025`, `0.05`, `0.075`, `0.1`, `0.25`, `0.5`, `0.75`, `1`, `2.5`, `5`, `7.5`, and `10`:

| Instrument | Attributes |
| --- | --- |
| `rpc.server.call.duration` | `rpc.system.name="effect"`, logical `rpc.method`, bounded `error.type` on failure |
| `http.server.request.duration` | request method, response status, scheme, bounded HTTP error class |
| `rpc.client.call.duration` | browser logical RPC method, `rpc.system.name="effect"`, bounded request error |

Histogram count is the request rate; no duplicate request counter is emitted. Unknown route templates are omitted rather than replaced with raw paths. Runtime-owned HTTP client/server spans suppress native URL, query, and header capture, while W3C context still connects browser and server spans. Exporter requests disable tracing and propagation so export cannot observe itself. Custom business metrics remain ordinary authored Effect `Metric` values.

Framework-owned telemetry never records RPC payloads/results, form values, authorization or cookie headers, session tokens, SQL bind values, URL queries, or arbitrary actor/resource identifiers. Undeclared command failures log a bounded type and operation name rather than a serialized cause. User-authored logs, custom span annotations, and authored native routes remain the application's privacy responsibility. The production Collector example adds defense-in-depth redaction; it cannot make arbitrary free text safe.

### Browser gateway

When UI and browser telemetry are enabled, the document receives only the same-origin ingestion path, derived public service name, sample rate, and enabled-signal booleans. Collector URLs and headers remain server-side. The default endpoints are `/otel/v1/traces`, `/otel/v1/metrics`, and `/otel/v1/logs`; CSP remains `connect-src 'self'`.

The gateway accepts same-origin `POST` requests with OTLP protobuf or JSON, enforces a 256 KiB body limit and 120 requests per remote address per minute by default, and rejects unknown paths, disabled signals, cross-origin requests, unsupported content types, and compressed bodies. It forwards only server-held collector headers; browser cookies and authorization never become collector credentials. Browser page-load, RPC, validation/request failure, uncaught-error, and unhandled-rejection events exclude raw form, response, DOM, and exception content. `pagehide` starts a bounded best-effort flush and cannot guarantee delivery.

### Reliability and custom runtimes

Native exporters retry transient responses, honor `Retry-After`, and temporarily disable a signal for 60 seconds after retries are exhausted. Application effects do not fail when a collector is slow, refuses a connection, returns 429, or returns 503. Buffered data dropped after exhausted retries is not recovered. Graceful scope or process interruption flushes all enabled signals up to each shutdown timeout; `SIGKILL` can lose application-buffered data.

The reference Collector adds memory limiting, batching, redaction, retry, internal telemetry, and a disk-backed sending queue. Delivery becomes restart-durable only after the Collector accepts it. `ops/observability/collector.production.example.yaml` is a hardened baseline with TLS and upstream-auth placeholders, not a production deployment.

For a custom runtime, import `ApplicationTelemetry` and provide `ApplicationTelemetry.layer(application, options)` around the complete runtime, supplying the native `HttpClient`. Apply `ApplicationTelemetry.httpMiddleware` once around the complete HTTP router and call `ApplicationTelemetry.browserGateway` while constructing UI routes. Opt out with `false` when another runtime owns the complete policy; do not install two exporters.

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
| `/` | Generated Application UI | When `ui` is enabled; its path is configurable |

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

### Generated Application UI

`ApplicationBun.run(application, { ui: true })` mounts the shared UI at `/`. The object form accepts `{ path?, presentation?, allowedOrigins? }`; `path` defaults to `/`. The runtime loads prebuilt `@effect-domains/application-ui` JavaScript and CSS and passes the compiled `ApplicationIR` inspection to the browser. It does not compile assets at startup.

The UI mechanically derives operation forms, resource navigation, resource lists, declared equality filters, cursor paging, and complete-JSON input from inspection. It invokes the same in-process RPC handlers as MCP, preserving middleware, service-dependent codecs, declared failures, and request-local authorization. Resource-specific browser reducers and transport clients are not part of an application.

`presentation` may provide an application title and description, resource labels and columns, and operation labels and descriptions. This display-only configuration does not alter canonical schemas, inspection, authorization, or handler behavior.

Protected operations use the bearer field. Tokens remain in memory and are never written to local or session storage. A successful `identity.login` operation places its returned token in that field; `identity.logout` clears it. The UI does not bypass authentication or infer permissions.

`allowedOrigins` lists exact origins accepted by the UI's call endpoint when using a non-loopback host. It is an origin check, not CORS configuration, authentication policy, or a permission grant. Loopback hosts are trusted by default.

Applications may still add native HTTP `routes` for behavior that is not a mechanical representation of an operation contract, such as downloading a generated artifact. They do not need authored browser startup, RPC, paging, form, session, or static-serving modules.

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

The Field Notes synchronization slice uses a native SQL `EventJournal`, typed `EventLog` events, remote replay, and a SQL projection. Concurrent edits converge by the authored `(revision, replicaId)` maximum; journal timestamps only identify native conflicts. Projection rebuild replays the persisted journal. EventLog remains an application-level policy seam and does not become canonical Resource or UI metadata.

## Sources

- [Bun runtime](../../packages/effect-domains/src/application-bun.ts)
- [Application composition](../../packages/effect-domains/src/application.ts)
- [Telemetry configuration](../../packages/effect-domains/src/application-telemetry.ts)
- [CLI adapter](../../packages/effect-domains/src/rpc-cli.ts)
- [MCP adapter](../../packages/effect-domains/src/rpc-mcp.ts)
- [Application UI adapter](../../packages/effect-domains/src/application-ui.ts)
- [Portable identity interface](../../packages/effect-domains/src/identity.ts)
- [Native identity RPC adapter](../../packages/effect-domains/src/identity-rpc.ts)
- [SQLite identity implementation](../../packages/effect-domains/src/sqlite-identity.ts)
- [SQLite Bun runtime](../../packages/effect-domains/src/sqlite-bun.ts)
- [Native Cluster runtime boundary](../../packages/example-support/src/cluster-runtime.ts)
- [Report execution outbox](../../examples/report-exports/executions.ts)
- [Field Notes EventLog synchronization](../../examples/field-notes/sync.ts)
