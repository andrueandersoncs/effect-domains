import { BunHttpServer, BunServices } from "@effect/platform-bun"
import { Array, Config, Context, Effect, Function, Layer, Option, type PlatformError, type Redacted, Schema, type Scope, Stdio, Stream, pipe } from "effect"
import { Argument, CliError, Command } from "effect/unstable/cli"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { type Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { Application } from "./application.ts"
import { ApplicationInspect } from "./application-inspect.ts"
import { RpcCli } from "./rpc-cli.ts"
import { SqliteBunRuntime } from "./sqlite-bun.ts"
import { SqliteMigrations, type SqliteMigration } from "./sqlite-migrations.ts"
import type { MigrationError } from "./migrations.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
import { RpcMcp } from "./rpc-mcp.ts"

type DatabaseOptions =
  | Readonly<{ manifest: string; filename: Option.Option<string> }>
  | Readonly<{ migrations: ReadonlyArray<SqliteMigration>; filename: Option.Option<string> }>

type RuntimeLayer = Layer.Layer<never, any, any>
type Initialization = Effect.Effect<any, any, any>

type RunOptions<Services extends RuntimeLayer, Initialize extends Initialization> = Readonly<{
  database: DatabaseOptions
  services: Services
  initialize: Initialize
}>

type ProvidedRuntime = Layer.Success<ReturnType<typeof SqliteBunRuntime.sqlClient>> | BunServices.BunServices | Scope.Scope

type RunRequirements<App extends Application, Services extends RuntimeLayer, Initialize extends Initialization> =
  | Exclude<Layer.Services<Services>, ProvidedRuntime>
  | Exclude<Layer.Services<App["handlers"]> | Effect.Services<Initialize>, ProvidedRuntime | Layer.Success<Services>>
  | Exclude<Rpc.ServicesClient<RpcGroup.Rpcs<App["group"]>> | Rpc.ServicesServer<RpcGroup.Rpcs<App["group"]>> | Rpc.MiddlewareClient<RpcGroup.Rpcs<App["group"]>>, BunServices.BunServices | Scope.Scope>

type RunErrors<App extends Application, Services extends RuntimeLayer, Initialize extends Initialization> =
  | Config.ConfigError | MigrationError | PlatformError.PlatformError | Schema.SchemaError | CliError.CliError
  | Layer.Error<ReturnType<typeof BunHttpServer.layer>> | Layer.Error<ReturnType<typeof SqliteBunRuntime.sqlClient>>
  | Layer.Error<ReturnType<typeof RpcMcp.layerHttp>>
  | Layer.Error<App["handlers"]>
  | Layer.Error<Services> | Effect.Error<Initialize>

const databaseEnvironmentVariable = (name: string) =>
  `${name.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_DB`

const serviceUrlEnvironmentVariable = (name: string) =>
  `${name.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_URL`

const databaseFilename = (name: string, configured: Option.Option<string>) => {
  const environment = databaseEnvironmentVariable(name)
  const fallback = pipe(Config.schema(Schema.NonEmptyString, environment), Config.withDefault(`${name}.sqlite`))
  return Option.match(configured, { onNone: Function.constant(fallback), onSome: Effect.succeed })
}

const serveApplication = Effect.fn("ApplicationBun.serve")(function* <
  App extends Application,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
>(application: App, options: RunOptions<Services, Initialize>) {
  const filename = yield* databaseFilename(application.name, options.database.filename)

  const migrations = "migrations" in options.database
    ? options.database.migrations
    : yield* SqliteMigrations.load(options.database.manifest)

  const port = yield* pipe(Config.port("PORT"), Config.withDefault(3000))
  const database = SqliteBunRuntime.sqlClient(filename, { migrations })
  const rpc = RpcServer.layerHttp({ group: application.group as RpcGroup.RpcGroup<Rpc.AnyWithProps>, path: "/rpc/v1", protocol: "http" })
  const mcp = RpcMcp.layerHttp({ name: application.name, group: application.group as RpcGroup.RpcGroup<Rpc.AnyWithProps>, path: "/mcp" })

  const routes = pipe(
    Layer.merge(rpc, mcp),
    Layer.provide(application.handlers),
    Layer.provide(AuthorizationRpc.layer),
    Layer.provide(RpcSerialization.layerJson),
  )

  const httpServer = BunHttpServer.layer({ hostname: "127.0.0.1", port })
  const server = pipe(HttpRouter.serve(routes), Layer.provide(httpServer))

  return yield* pipe(
    Effect.gen(function* () {
      const databaseContext = yield* Layer.build(database)
      yield* pipe(Application.prepare(application), Effect.provideContext(databaseContext))
      const services = yield* pipe(Layer.build(options.services), Effect.provideContext(databaseContext))
      const serviceContext = Context.merge(databaseContext, services)
      yield* Effect.provideContext(options.initialize, serviceContext)
      return yield* pipe(Layer.launch(server), Effect.provideContext(serviceContext))
    }),
    Effect.scoped,
  )
})

const inspectCommand = (application: Application) => {
  const operation = pipe(Argument.string("operation"), Argument.optional)

  const inspect = Effect.fn("ApplicationBun.inspect")(function* ({ operation }: Readonly<{ operation: Option.Option<string> }>) {
    const inspection = ApplicationInspect.describe(application, operation)
    const selected = Option.isSome(operation)
    const missing = Array.isReadonlyArrayEmpty(inspection.operations)
    const unknownOperation = selected && missing

    if (unknownOperation) {
      return yield* CliError.UserError.make({
        cause: operation.value,
        userMessage: `Unknown application operation ${operation.value}`,
      })
    }

    const output = JSON.stringify(inspection, null, 2)
    const stdio = yield* Stdio.Stdio
    const stream = Stream.make(`${output}\n`)
    const stdout = stdio.stdout()
    yield* Stream.run(stream, stdout)
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
  App extends Application,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
>(application: App, options: RunOptions<Services, Initialize>) {
  const environment = serviceUrlEnvironmentVariable(application.name)
  const defaultUrl = new URL("http://127.0.0.1:3000/rpc/v1")

  const protocol = pipe(
    Effect.gen(function* () {
      const url = yield* pipe(Config.schema(Schema.URLFromString, environment), Config.withDefault(defaultUrl))
      const tokenEnvironment = `${application.name.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_TOKEN`
      const token = yield* pipe(Config.redacted(tokenEnvironment), Config.option)
      return clientProtocol(url, token)
    }),
    Layer.unwrap,
  )

  const migrations = "migrations" in options.database ? Option.some(options.database.migrations) : Option.none()
  const manifest = "manifest" in options.database ? Option.some(options.database.manifest) : Option.none()

  const schema = SqliteMigrations.command({
    name: "schema",
    tables: application.tables,
    migrations,
    manifest,
  })

  const serve = () => serveApplication(application, options)
  const serveCommand = Command.make("serve", {}, serve)
  const inspection = inspectCommand(application)

  const command = RpcCli.make({
    name: application.name,
    group: application.group,
    protocol,
    subcommands: [serveCommand, schema, inspection],
  })

  return yield* Command.run(command, { version: "0.1.0" })
})

export const ApplicationBun = {
  run: Effect.fn("ApplicationBun.run")(function* <
    App extends Application,
    Services extends RuntimeLayer,
    Initialize extends Initialization,
  >(application: App, options: RunOptions<Services, Initialize>) {
    return yield* pipe(
      runApplication(application, options),
      Effect.provide(BunServices.layer),
    ) as Effect.Effect<void, RunErrors<App, Services, Initialize>, RunRequirements<App, Services, Initialize>>
  }),
}
