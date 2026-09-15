import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun"
import { ApplicationUiAssetFiles } from "@effect-domains/application-ui/assets"
import { Array, Config, Context, Effect, Layer, Option, type PlatformError, Predicate, type Redacted, Schema, type Scope, Stdio, Stream, pipe } from "effect"
import { Argument, CliError, Command } from "effect/unstable/cli"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { type Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { Application, type ApplicationIR } from "./application.ts"
import { ApplicationUi, type ApplicationUiOptions } from "./application-ui.ts"
import { ApplicationInspect } from "./application-inspect.ts"
import { ApplicationTelemetry, type TelemetryOptions } from "./application-telemetry.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
import { RpcCli } from "./rpc-cli.ts"
import { RpcMcp } from "./rpc-mcp.ts"
import { environmentPrefix, SqliteBunRuntime } from "./sqlite-bun.ts"
import { type SqliteMigration } from "./sqlite-migrations.ts"
import type { MigrationError } from "./migrations.ts"

type RuntimeLayer = Layer.Layer<never, any, any>
type Initialization = Effect.Effect<any, any, any>

type RunOptions<
  Services extends RuntimeLayer = Layer.Layer<never, never, never>,
  Initialize extends Initialization = Effect.Effect<void>,
  Background extends RuntimeLayer = Layer.Layer<never, never, never>,
  Routes extends RuntimeLayer = Layer.Layer<never, never, never>,
> = Readonly<{
  database: Readonly<{ migrations: ReadonlyArray<SqliteMigration> } & Partial<{ filename: string }>>
}> & Readonly<Partial<{
  services: Services
  initialize: Initialize
  background: Background
  routes: Routes
  ui: true | ApplicationUiOptions
  telemetry: false | TelemetryOptions
}>>

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

const withApplicationRuntime = Effect.fn("ApplicationBun.runtime")(function* <
  App extends ApplicationIR,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Background extends RuntimeLayer,
  Routes extends RuntimeLayer,
>(
  application: App,
  options: RunOptions<Services, Initialize, Background, Routes>,
  use: Effect.Effect<unknown, unknown, any>,
) {
  const configuredFilename = Option.fromNullishOr(options.database.filename)
  const filename = yield* databaseFilename(application.name, configuredFilename)
  const database = SqliteBunRuntime.sqlClient(filename, { migrations: options.database.migrations })
  const databaseContext = yield* Layer.build(database)
  yield* pipe(Application.prepare(application), Effect.provideContext(databaseContext))

  const services = yield* pipe(
    Layer.build(options.services ?? Layer.empty),
    Effect.provideContext(databaseContext),
  )

  const serviceContext = Context.merge(databaseContext, services)
  yield* Effect.provideContext(options.initialize ?? Effect.void, serviceContext)

  const background = yield* pipe(
    Layer.build(options.background ?? Layer.empty),
    Effect.provideContext(serviceContext),
  )

  const runtimeContext = Context.merge(serviceContext, background)
  return yield* pipe(use, Effect.provideContext(runtimeContext))
})

const serveApplication = Effect.fn("ApplicationBun.serve")(function* <
  App extends ApplicationIR,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Background extends RuntimeLayer,
  Routes extends RuntimeLayer,
>(application: App, options: RunOptions<Services, Initialize, Background, Routes>) {
  const port = yield* pipe(Config.port("PORT"), Config.withDefault(3000))
  const rpc = RpcServer.layerHttp({ group: application.group as RpcGroup.RpcGroup<Rpc.AnyWithProps>, path: "/rpc/v1", protocol: "http" })
  const mcp = RpcMcp.layerHttp({ application, path: "/mcp" })

  const ui = yield* pipe(
    Option.fromNullishOr(options.ui),
    Option.match({
      onNone: () => Effect.succeed(Layer.empty),
      onSome: Effect.fn("ApplicationBun.ui")(function* (configuration) {
        const assets = yield* readApplicationUiAssets()
        const presentation = Predicate.isBoolean(configuration) ? {} : configuration
        return ApplicationUi.layerHttp({ application, ...assets, ...presentation })
      }),
    }),
  )

  const routes = pipe(
    Layer.mergeAll(rpc, mcp, ui, options.routes ?? Layer.empty),
    Layer.provideMerge(application.handlers),
    Layer.provide(AuthorizationRpc.layer),
    Layer.provide(RpcSerialization.layerJson),
  )

  const httpServer = BunHttpServer.layer({ hostname: "127.0.0.1", port })
  const server = pipe(HttpRouter.serve(routes), Layer.provide(httpServer))
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
  const defaultUrl = new URL("http://127.0.0.1:3000/rpc/v1")

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

export const ApplicationBun = {
  run: Effect.fn("ApplicationBun.run")(function* <
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

    return yield* pipe(
      runApplication(application, options),
      Effect.provide(BunServices.layer),
      Effect.provide(telemetry),
    ) as Effect.Effect<
      void,
      RunErrors<App, Services, Initialize, Background, Routes>,
      RunRequirements<App, Services, Initialize, Background, Routes>
    >
  }),
  runMain: BunRuntime.runMain,
}
