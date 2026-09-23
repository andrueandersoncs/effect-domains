import { BunHttpServer, BunServices } from "@effect/platform-bun"
import { Array, Config, Effect, Layer, Option, type PlatformError, Predicate, type Redacted, Schema, type Scope, Stdio, Stream, pipe } from "effect"
import { Argument, CliError, Command } from "effect/unstable/cli"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpMiddleware, HttpRouter } from "effect/unstable/http"
import { type Rpc, RpcClient, RpcGroup, RpcSerialization } from "effect/unstable/rpc"
import type { ApplicationIR } from "./application.ts"
import { ApplicationUiAssetsError, readApplicationUiAssets } from "./application-bun-ui-assets.ts"
import { ApplicationUi } from "./application-ui.ts"
import { ApplicationInspect } from "./application-inspect.ts"


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

export type RunRequirements<
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



export type RunErrors<
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


const databaseFilename = (name: string, configured: Option.Option<string>) => {
  const environment = environmentPrefix(name)

  return Option.match(configured, {
    onNone: () => pipe(
      Config.schema(Schema.NonEmptyString, `${environment}_DB`),
      Config.withDefault(`data/${name}.sqlite`),
    ),
    onSome: Config.succeed,
  })
}



const withApplicationRuntime = Effect.fn("ApplicationBun.withApplicationRuntime")(function* <
  App extends ApplicationIR,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Background extends RuntimeLayer,
  UseSuccess,
  UseError,
  UseRequirements,
>(
  application: App,
  options: RuntimeOptions<Services, Initialize, Background>,
  use: Effect.Effect<UseSuccess, UseError, UseRequirements>,
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
  const uiConfigured = !Predicate.isBoolean(options.ui)
  const uiAssets = uiConfigured ? yield* readApplicationUiAssets() : undefined

  const routes = yield* ApplicationRuntime.httpLayer(application, {
    routes: options.routes,
    rpc: options.rpc,
    mcp: options.mcp,
    ui: options.ui,
    telemetry: options.telemetry,
    uiAssets,
  })

  const httpServer = BunHttpServer.layer({ hostname: "127.0.0.1", port })

  const servedRoutes = telemetryDisabled
    ? HttpRouter.serve(routes)
    : HttpRouter.serve(routes, {
      disableLogger: true,
      middleware: ApplicationTelemetry.httpMiddleware,
    })

  const serverBase = pipe(servedRoutes, Layer.provide(httpServer))
  const tracerDisabled = Layer.succeed(HttpMiddleware.TracerDisabledWhen, () => true)
  const tracedServer = pipe(serverBase, Layer.provide(tracerDisabled))
  const server = telemetryDisabled ? serverBase : tracedServer
  const serving = Layer.launch(server)

  return yield* pipe(withApplicationRuntime(application, options, serving), Effect.scoped)
})


const makeInspectCommand = (application: ApplicationIR, localCommands: ReadonlyArray<string>) => {
  const operation = pipe(Argument.string("operation"), Argument.optional)

  const inspect = Effect.fn("ApplicationBun.inspect")(function* ({ operation }: Readonly<{ operation: Option.Option<string> }>) {
    const inspection = yield* ApplicationInspect.describe(application, operation, localCommands)
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
    const outputStream = Stream.make(`${output}\n`)

    yield* pipe(outputStream, Stream.run(stdout))
  })

  return Command.make("inspect", { operation }, inspect)
}

const clientProtocolLayer = (url: URL, token: Option.Option<Redacted.Redacted<string>>) => pipe(
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

const runCli = Effect.fn("ApplicationBun.runCli")(function* <
  App extends ApplicationIR,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Background extends RuntimeLayer,
  Routes extends RuntimeLayer,
>(application: App, options: RunOptions<Services, Initialize, Background, Routes>) {
  const environment = environmentPrefix(application.name)
  const rpcOptions = Predicate.isBoolean(options.rpc) ? undefined : options.rpc
  const rpcPath = rpcOptions?.path ?? "/rpc/v1"
  const defaultUrl = new URL(`http://127.0.0.1:3000${rpcPath}`)

  const makeProtocolLayer = Effect.fn("ApplicationBun.makeProtocolLayer")(function* () {
    const urlConfig = pipe(
      Config.schema(Schema.URLFromString, `${environment}_URL`),
      Config.withDefault(defaultUrl),
    )
    const tokenConfig = pipe(Config.redacted(`${environment}_TOKEN`), Config.option)
    const url = yield* urlConfig
    const token = yield* tokenConfig

    return clientProtocolLayer(url, token)
  })
  const protocol = Layer.unwrap(makeProtocolLayer())

  const serveCommandHandler = Effect.fn("ApplicationBun.serveCommand")(function* () {
    return yield* serveApplication(application, options)
  })
  const serveCommand = Command.make("serve", {}, serveCommandHandler)
  const background = Option.fromNullishOr(options.background)

  const localCommands = Option.match(background, {
    onNone: () => ["serve", "inspect"],
    onSome: () => ["serve", "worker", "inspect"],
  })

  const inspect = makeInspectCommand(application, localCommands)
  const workerHandler = Effect.fn("ApplicationBun.worker")(function* () {
    const lifetime = pipe(Effect.log(`Worker ready: ${application.name}`), Effect.andThen(Effect.never))

    return yield* pipe(withApplicationRuntime(application, options, lifetime), Effect.scoped)
  })
  const workerCommand = Command.make("worker", {}, workerHandler)
  const subcommands = Option.isSome(background)
    ? [serveCommand, workerCommand, inspect]
    : [serveCommand, inspect]

  const command = RpcCli.make({
    application,
    protocol,
    subcommands,
  })

  return yield* Command.run(command, { version: "0.1.0" })
})

export const runApplication = Effect.fn("ApplicationBun.run")(function* <
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

  // SAFETY: The effect error and requirement channels match because runCli derives them from the same application and options types.
  return yield* pipe(
    runCli(application, options),
    Effect.provide(BunServices.layer),
    Effect.provide(telemetry),
  ) as Effect.Effect<
    void,
    RunErrors<App, Services, Initialize, Background, Routes>,
    RunRequirements<App, Services, Initialize, Background, Routes>
  >
})