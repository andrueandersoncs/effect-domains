import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun"
import { ApplicationUiAssetFiles } from "@effect-domains/application-ui/assets"
import { Array, Config, Data, Effect, Equivalence, Function, Layer, Option, type PlatformError, Predicate, type Redacted, Schema, type Scope, Stdio, Stream, pipe } from "effect"
import { Argument, CliError, Command } from "effect/unstable/cli"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpMiddleware, HttpRouter } from "effect/unstable/http"
import { type Rpc, RpcClient, RpcGroup, RpcSerialization } from "effect/unstable/rpc"
import type { ApplicationIR } from "./application.ts"
import { ApplicationUi, type ApplicationUiOptions } from "./application-ui.ts"
import { ApplicationInspect } from "./application-inspect.ts"
import { ApplicationInfrastructure, type ApplicationInfrastructureError } from "./application-infrastructure.ts"
import type { ApplicationInfrastructureIR } from "./infrastructure-compiler.ts"


import type { ApplicationHttpOptions, ApplicationRuntimeOptions, Initialization, RuntimeLayer } from "./application-runtime.ts"
import * as ApplicationRuntime from "./application-runtime.ts"

import { ApplicationTelemetry } from "./application-telemetry.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
import { RpcCli } from "./rpc-cli.ts"
import { RpcMcp } from "./rpc-mcp.ts"
import { SqliteBunRuntime } from "./sqlite-bun.ts"
import { environmentPrefix } from "./sqlite-runtime.ts"
import { type SqliteMigration } from "./sqlite-migrations.ts"
import type { MigrationError } from "./migrations.ts"


type DatabaseOptions = Readonly<{
  database: Readonly<{ migrations: ReadonlyArray<SqliteMigration> } & Partial<{ filename: string }>>
}>

class InfrastructureDatabaseOptions extends Data.Class<{
  readonly migrations: ReadonlyArray<SqliteMigration>
}> {}

class InfrastructureFileDatabaseOptions extends Data.Class<{
  readonly migrations: ReadonlyArray<SqliteMigration>
  readonly filename: string
}> {}

type RuntimeOptions<
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Background extends RuntimeLayer,
> = DatabaseOptions & ApplicationRuntimeOptions<Services, Initialize, Background>

type RunOptions<
  Services extends RuntimeLayer = Layer.Layer<never, never, never>,
  Initialize extends Initialization = Effect.Effect<void>,
  Background extends RuntimeLayer = Layer.Layer<never, never, never>,
  Routes extends RuntimeLayer = Layer.Layer<never, never, never>,
> = DatabaseOptions & ApplicationHttpOptions<Services, Initialize, Background, Routes>

type InfrastructureRunOptions<
  Services extends RuntimeLayer = Layer.Layer<never, never, never>,
  Initialize extends Initialization = Effect.Effect<void>,
  Background extends RuntimeLayer = Layer.Layer<never, never, never>,
  Routes extends RuntimeLayer = Layer.Layer<never, never, never>,
> = Omit<
  ApplicationHttpOptions<Services, Initialize, Background, Routes>,
  "rpc" | "mcp" | "ui" | "uiAssets"
> & Readonly<Partial<{ database: Readonly<{ filename: string }> }>>

type ProvidedRuntime = Layer.Success<ReturnType<typeof SqliteBunRuntime.sqlClient>> | BunServices.BunServices | Scope.Scope

type ServiceRuntime<Services extends RuntimeLayer> = ProvidedRuntime | Layer.Success<Services>

type RouteRuntime<
  App extends ApplicationIR,
  Services extends RuntimeLayer,
  Background extends RuntimeLayer,
> = ServiceRuntime<Services> | Layer.Success<App["handlers"]> | Layer.Success<Background> | HttpRouter.HttpRouter

type RouteRequirements<Routes extends RuntimeLayer> =
  | HttpRouter.Request.Without<Layer.Services<Routes>>
  | Exclude<HttpRouter.Request.Only<"Requires", Layer.Services<Routes>> | HttpRouter.Request.Only<"GlobalRequires", Layer.Services<Routes>>, HttpRouter.GlobalProvided>

type RunRequirements<
  App extends ApplicationIR,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Background extends RuntimeLayer,
  Routes extends RuntimeLayer,
> =
  | Exclude<Layer.Services<Services>, ProvidedRuntime>
  | Exclude<Effect.Services<Initialize> | Layer.Services<Background>, ServiceRuntime<Services>>
  | Exclude<Layer.Services<App["handlers"]> | RouteRequirements<Routes>, RouteRuntime<App, Services, Background>>
  | Exclude<Rpc.Middleware<RpcGroup.Rpcs<App["group"]>>, RouteRuntime<App, Services, Background> | AuthorizationRpc>
  | Exclude<Rpc.ServicesClient<RpcGroup.Rpcs<App["group"]>> | Rpc.ServicesServer<RpcGroup.Rpcs<App["group"]>> | Rpc.MiddlewareClient<RpcGroup.Rpcs<App["group"]>>, BunServices.BunServices | Scope.Scope>

class ApplicationUiAssetsError extends Schema.TaggedError<ApplicationUiAssetsError>()(
  "ApplicationBunUiAssetsError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

class InfrastructureDatabaseConfigurationError extends Schema.TaggedError<InfrastructureDatabaseConfigurationError>()(
  "InfrastructureDatabaseConfigurationError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

type RunErrors<
  App extends ApplicationIR,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Background extends RuntimeLayer,
  Routes extends RuntimeLayer,
> =
  | ApplicationUiAssetsError
  | Config.ConfigError | MigrationError | PlatformError.PlatformError | Schema.SchemaError | CliError.CliError
  | Layer.Error<ReturnType<typeof BunHttpServer.layer>> | Layer.Error<ReturnType<typeof SqliteBunRuntime.sqlClient>>
  | Layer.Error<ReturnType<typeof RpcMcp.layerHttp>> | Layer.Error<ReturnType<typeof ApplicationUi.layerHttp>>
  | Layer.Error<App["handlers"]>
  | Layer.Error<Services> | Effect.Error<Initialize> | Layer.Error<Background> | Layer.Error<Routes>

type InfrastructureRunEffect<
  App extends ApplicationIR,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Background extends RuntimeLayer,
  Routes extends RuntimeLayer,
> = Effect.Effect<
  void,
  | ApplicationInfrastructureError
  | InfrastructureDatabaseConfigurationError
  | RunErrors<App, Services, Initialize, Background, Routes>,
  RunRequirements<App, Services, Initialize, Background, Routes>
>

const databaseFilename = (name: string, configured: Option.Option<string>) => {
  const environment = environmentPrefix(name)

  return Option.match(configured, {
    onNone: () => pipe(Config.schema(Schema.NonEmptyString, `${environment}_DB`), Config.withDefault(`data/${name}.sqlite`)),
    onSome: Effect.succeed,
  })
}

const readApplicationUiAsset = (file: URL) => Effect.tryPromise({
  try: () => Bun.file(file).text(),
  catch: (cause) => ApplicationUiAssetsError.make({
    reason: `Could not read prebuilt application UI asset ${file.pathname}. Run \`bun run build\` before serving with the application UI enabled. ${String(cause)}`,
  }),
})

const readApplicationUiAssets = Effect.fn("ApplicationBun.readApplicationUiAssets")(function* () {
  const javascript = readApplicationUiAsset(ApplicationUiAssetFiles.javascript)
  const stylesheet = readApplicationUiAsset(ApplicationUiAssetFiles.stylesheet)

  return yield* Effect.all({ javascript, stylesheet }, { concurrency: "unbounded" })
})

const uiEnabled = (configuration: false | true | ApplicationUiOptions) =>
  Predicate.isBoolean(configuration) ? configuration : true

const withApplicationRuntime = Effect.fn("ApplicationBun.runtime")(function* <
  App extends ApplicationIR,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Background extends RuntimeLayer,
>(
  application: App,
  options: RuntimeOptions<Services, Initialize, Background>,
  use: Effect.Effect<unknown, unknown, any>,
) {
  const configuredFilename = Option.fromNullishOr(options.database.filename)
  const filename = yield* databaseFilename(application.name, configuredFilename)
  const database = SqliteBunRuntime.sqlClient(filename, { migrations: options.database.migrations })

  return yield* ApplicationRuntime.use(application, database, {
    services: options.services,
    initialize: options.initialize,
    background: options.background,
  }, use)
})

const serveApplication = Effect.fn("ApplicationBun.serve")(function* <
  App extends ApplicationIR,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Background extends RuntimeLayer,
  Routes extends RuntimeLayer,
>(application: App, options: RunOptions<Services, Initialize, Background, Routes>) {
  const port = yield* pipe(Config.port("PORT"), Config.withDefault(3000))
  const telemetryDisabled = Predicate.isBoolean(options.telemetry)
  const noUiAssets = Option.none<Readonly<{ javascript: string; stylesheet: string }>>()
  const noUiAssetsEffect = Effect.succeed(noUiAssets)
  const configuredUiAssetsEffect = pipe(readApplicationUiAssets(), Effect.map(Option.some))

  const configuredUi = pipe(
    Option.fromNullishOr(options.ui),
    Option.filter(uiEnabled),
  )

  const uiAssets = yield* Option.match(configuredUi, {
    onNone: Function.constant(noUiAssetsEffect),
    onSome: Function.constant(configuredUiAssetsEffect),
  })

  const optionalUiAssets = Option.getOrUndefined(uiAssets)

  const routes = yield* ApplicationRuntime.httpLayer(application, {
    services: options.services,
    initialize: options.initialize,
    background: options.background,
    routes: options.routes,
    rpc: options.rpc,
    mcp: options.mcp,
    ui: options.ui,
    telemetry: options.telemetry,
    uiAssets: optionalUiAssets,
  })

  const httpServer = BunHttpServer.layer({ hostname: "127.0.0.1", port })

  const servedRoutes = telemetryDisabled
    ? HttpRouter.serve(routes)
    : HttpRouter.serve(routes, {
      disableLogger: true,
      middleware: ApplicationTelemetry.httpMiddleware,
    })

  const serverBase = pipe(servedRoutes, Layer.provide(httpServer))
  const tracerDisabled = Layer.succeed(HttpMiddleware.TracerDisabledWhen, Function.constant(true))

  const server = telemetryDisabled
    ? serverBase
    : pipe(serverBase, Layer.provide(tracerDisabled))

  const serving = Layer.launch(server)

  return yield* pipe(
    withApplicationRuntime(application, options, serving),
    Effect.scoped,
  )
})


const inspectCommand = (application: ApplicationIR, localCommands: ReadonlyArray<string>) => {
  const operation = pipe(Argument.string("operation"), Argument.optional)

  const inspect = Effect.fn("ApplicationBun.inspect")(function* ({ operation }: Readonly<{ operation: Option.Option<string> }>) {
    const inspection = ApplicationInspect.describe(application, operation, localCommands)
    const missingOperation = Option.isSome(operation) && Array.isReadonlyArrayEmpty(inspection.operations)

    if (missingOperation) {
      return yield* CliError.UserError.make({
        cause: operation.value,
        userMessage: `Unknown application operation ${operation.value}`,
      })
    }

    const output = JSON.stringify(inspection, null, 2)
    const stdio = yield* Stdio.Stdio
    const stdout = stdio.stdout()

    yield* pipe(Stream.make(`${output}\n`), Stream.run(stdout))
  })

  return Command.make("inspect", { operation }, inspect)
}

const clientProtocol = (url: URL, token: Option.Option<Redacted.Redacted<string>>) => pipe(
  RpcClient.layerProtocolHttp({
    url: url.href,
    transformClient: (client) => Option.match(token, {
      onNone: () => client,
      onSome: (value) => HttpClient.mapRequest(client, HttpClientRequest.bearerToken(value)),
    }),
  }),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerJson),
)

const runApplication = Effect.fn("ApplicationBun.run")(function* <
  App extends ApplicationIR,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Background extends RuntimeLayer,
  Routes extends RuntimeLayer,
>(application: App, options: RunOptions<Services, Initialize, Background, Routes>) {
  const environment = environmentPrefix(application.name)
  const rpcPath = Predicate.isBoolean(options.rpc) ? "/rpc/v1" : options.rpc?.path ?? "/rpc/v1"
  const defaultUrl = new URL(`http://127.0.0.1:3000${rpcPath}`)

  const protocol = pipe(
    Effect.gen(function* () {
      const url = yield* pipe(Config.schema(Schema.URLFromString, `${environment}_URL`), Config.withDefault(defaultUrl))
      const token = yield* pipe(Config.redacted(`${environment}_TOKEN`), Config.option)

      return clientProtocol(url, token)
    }),
    Layer.unwrap,
  )

  const serveCommand = Command.make("serve", {}, () => serveApplication(application, options))
  const background = Option.fromNullishOr(options.background)

  const localCommands = Option.match(background, {
    onNone: () => ["serve", "inspect"],
    onSome: () => ["serve", "worker", "inspect"],
  })

  const inspection = inspectCommand(application, localCommands)

  const subcommands = Option.match(background, {
    onNone: () => [serveCommand, inspection],
    onSome: () => {
      const worker = Effect.fn("ApplicationBun.worker")(function* () {
        const lifetime = pipe(Effect.log(`Worker ready: ${application.name}`), Effect.andThen(Effect.never))

        return yield* pipe(withApplicationRuntime(application, options, lifetime), Effect.scoped)
      })

      const workerCommand = Command.make("worker", {}, worker)

      return [serveCommand, workerCommand, inspection]
    },
  })

  const command = RpcCli.make({
    application,
    protocol,
    subcommands,
  })

  return yield* Command.run(command, { version: "0.1.0" })
})

const run = Effect.fn("ApplicationBun.run")(function* <
  App extends ApplicationIR,
  Services extends RuntimeLayer = Layer.Layer<never, never, never>,
  Initialize extends Initialization = Effect.Effect<void>,
  Background extends RuntimeLayer = Layer.Layer<never, never, never>,
  Routes extends RuntimeLayer = Layer.Layer<never, never, never>,
>(application: App, options: RunOptions<Services, Initialize, Background, Routes>) {
  const telemetry = pipe(
    ApplicationTelemetry.layer(application, options.telemetry),
    Layer.provide(FetchHttpClient.layer),
  )

  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  return yield* pipe(
    runApplication(application, options),
    Effect.provide(BunServices.layer),
    Effect.provide(telemetry),
    // SAFETY: The effect error and requirement channels match because runApplication derives them from the same application and options types.
  ) as Effect.Effect<
    void,
    RunErrors<App, Services, Initialize, Background, Routes>,
    RunRequirements<App, Services, Initialize, Background, Routes>
  >
})

const runInfrastructureEffect = Effect.fn("ApplicationBun.runInfrastructure")(function* <
  App extends ApplicationIR,
  Services extends RuntimeLayer = Layer.Layer<never, never, never>,
  Initialize extends Initialization = Effect.Effect<void>,
  Background extends RuntimeLayer = Layer.Layer<never, never, never>,
  Routes extends RuntimeLayer = Layer.Layer<never, never, never>,
>(
  infrastructure: ApplicationInfrastructureIR<App>,
  options: InfrastructureRunOptions<Services, Initialize, Background, Routes> = {},
) {
  const plan = yield* ApplicationInfrastructure.plan("ApplicationBun", infrastructure)
  const http = ApplicationInfrastructure.httpOptions(plan.runtime.resource)
  const configuredFilename = pipe(Option.fromNullishOr(options.database), Option.map(({ filename }) => filename))

  const ephemeral = Equivalence.strictEqual<"ephemeral" | "persistent">()(
    plan.database.resource.durability,
    "ephemeral",
  )

  const configuredPersistentFile = Option.isSome(configuredFilename)
  const invalidEphemeralFilename = ephemeral && configuredPersistentFile

  if (invalidEphemeralFilename) {
    return yield* InfrastructureDatabaseConfigurationError.make({
      reason: "An ephemeral infrastructure database cannot use a persistent filename",
    })
  }

  const defaultDatabase = ephemeral
    ? new InfrastructureFileDatabaseOptions({
      migrations: plan.database.resource.migrations,
      filename: ":memory:",
    })
    : new InfrastructureDatabaseOptions({ migrations: plan.database.resource.migrations })

  const database = Option.match(configuredFilename, {
    onNone: Function.constant(defaultDatabase),
    onSome: (filename) => new InfrastructureFileDatabaseOptions({
      migrations: plan.database.resource.migrations,
      filename,
    }),
  })

  return yield* run(plan.application, {
    ...options,
    ...http,
    database,
  })
})

function publishInfrastructure<App extends ApplicationIR>(
  infrastructure: ApplicationInfrastructureIR<App>,
): InfrastructureRunEffect<
  App,
  Layer.Layer<never, never, never>,
  Effect.Effect<void>,
  Layer.Layer<never, never, never>,
  Layer.Layer<never, never, never>
>

function publishInfrastructure<
  App extends ApplicationIR,
  Services extends RuntimeLayer = Layer.Layer<never, never, never>,
  Initialize extends Initialization = Effect.Effect<void>,
  Background extends RuntimeLayer = Layer.Layer<never, never, never>,
  Routes extends RuntimeLayer = Layer.Layer<never, never, never>,
>(
  infrastructure: ApplicationInfrastructureIR<App>,
  options: InfrastructureRunOptions<Services, Initialize, Background, Routes>,
): InfrastructureRunEffect<App, Services, Initialize, Background, Routes>

function publishInfrastructure(
  infrastructure: ApplicationInfrastructureIR<ApplicationIR>,
  options: InfrastructureRunOptions<RuntimeLayer, Initialization, RuntimeLayer, RuntimeLayer> = {},
): Effect.Effect<void, unknown, unknown> {
  return pipe(runInfrastructureEffect(infrastructure, options), Effect.asVoid)
}

export const ApplicationBun = {
  run: Effect.fn("ApplicationBun.run")(function* <
    App extends ApplicationIR,
    Services extends RuntimeLayer = Layer.Layer<never, never, never>,
    Initialize extends Initialization = Effect.Effect<void>,
    Background extends RuntimeLayer = Layer.Layer<never, never, never>,
    Routes extends RuntimeLayer = Layer.Layer<never, never, never>,
  >(application: App, options: RunOptions<Services, Initialize, Background, Routes>) {
    return yield* run(application, options)
  }),
  runInfrastructure: publishInfrastructure,
  runMain: BunRuntime.runMain,
}
