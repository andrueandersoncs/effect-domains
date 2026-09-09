import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun"
import { Array, Config, Context, Effect, Function, Layer, Option, type PlatformError, type Redacted, Schema, type Scope, Stdio, Stream, Struct, pipe } from "effect"
import { Argument, CliError, Command } from "effect/unstable/cli"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { type Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { Application } from "./application.ts"
import { ApplicationAdmin, type AdminOptions } from "./application-admin.ts"
import { ApplicationInspect } from "./application-inspect.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
import { RpcCli } from "./rpc-cli.ts"
import { RpcMcp } from "./rpc-mcp.ts"
import { SqliteBunRuntime } from "./sqlite-bun.ts"
import { SqliteMigrations, type SqliteMigration } from "./sqlite-migrations.ts"
import type { MigrationError } from "./migrations.ts"

type RuntimeLayer = Layer.Layer<never, any, any>
type Initialization = Effect.Effect<any, any, any>

type RunOptions<
  Services extends RuntimeLayer = Layer.Layer<never, never, never>,
  Initialize extends Initialization = Effect.Effect<void>,
> = Readonly<{
  database:
    | Readonly<{ manifest: string | URL; filename?: string }>
    | Readonly<{ migrations: ReadonlyArray<SqliteMigration>; filename?: string }>
  services?: Services
  initialize?: Initialize
  admin?: true | AdminOptions
}>

type ProvidedRuntime = Layer.Success<ReturnType<typeof SqliteBunRuntime.sqlClient>> | BunServices.BunServices | Scope.Scope

type RunRequirements<App extends Application, Services extends RuntimeLayer, Initialize extends Initialization> =
  | Exclude<Layer.Services<Services>, ProvidedRuntime>
  | Exclude<Layer.Services<App["handlers"]> | Effect.Services<Initialize>, ProvidedRuntime | Layer.Success<Services>>
  | Exclude<Rpc.ServicesClient<RpcGroup.Rpcs<App["group"]>> | Rpc.ServicesServer<RpcGroup.Rpcs<App["group"]>> | Rpc.MiddlewareClient<RpcGroup.Rpcs<App["group"]>>, BunServices.BunServices | Scope.Scope>


class AdminBuildError extends Schema.TaggedError<AdminBuildError>()(
  "ApplicationBunAdminBuildError",
  { reason: Schema.String },
) {}

type RunErrors<App extends Application, Services extends RuntimeLayer, Initialize extends Initialization> =
  | AdminBuildError
  | Config.ConfigError | MigrationError | PlatformError.PlatformError | Schema.SchemaError | CliError.CliError
  | Layer.Error<ReturnType<typeof BunHttpServer.layer>> | Layer.Error<ReturnType<typeof SqliteBunRuntime.sqlClient>>
  | Layer.Error<ReturnType<typeof RpcMcp.layerHttp>> | Layer.Error<ReturnType<typeof ApplicationAdmin.layerHttp>>
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

const bundleAdminClient = Effect.fn("ApplicationBun.bundleAdminClient")(function* () {
  const clientUrl = new URL("./admin-client.ts", import.meta.url)
  const entrypoint = Bun.fileURLToPath(clientUrl)
  const build = yield* Effect.tryPromise({
    try: () => Bun.build({ entrypoints: [entrypoint], target: "browser", minify: true }),
    catch: (cause) => AdminBuildError.make({ reason: String(cause) }),
  })

  if (!build.success) {
    return yield* AdminBuildError.make({ reason: "Bun could not bundle the admin client" })
  }

  const output = yield* pipe(
    Array.head(build.outputs),
    Option.match({
      onNone: () => AdminBuildError.make({ reason: "Bun did not produce an admin client bundle" }),
      onSome: Effect.succeed,
    }),
  )

  return yield* Effect.tryPromise({
    try: () => output.text(),
    catch: (cause) => AdminBuildError.make({ reason: String(cause) }),
  })
})

const serveApplication = Effect.fn("ApplicationBun.serve")(function* <
  App extends Application,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
>(application: App, options: RunOptions<Services, Initialize>, manifest: Option.Option<string>) {
  const filename = yield* databaseFilename(application.name, Option.fromNullishOr(options.database.filename))

  const migrations = yield* ("migrations" in options.database
    ? Effect.succeed(options.database.migrations)
    : pipe(
      manifest,
      Option.match({
        onNone: Function.constant(Effect.never),
        onSome: SqliteMigrations.load,
      }),
    ))

  const port = yield* pipe(Config.port("PORT"), Config.withDefault(3000))
  const database = SqliteBunRuntime.sqlClient(filename, { migrations })
  const rpc = RpcServer.layerHttp({ group: application.group as RpcGroup.RpcGroup<Rpc.AnyWithProps>, path: "/rpc/v1", protocol: "http" })
  const mcp = RpcMcp.layerHttp({ name: application.name, group: application.group as RpcGroup.RpcGroup<Rpc.AnyWithProps>, path: "/mcp" })
  const admin = yield* pipe(
    Option.fromNullishOr(options.admin),
    Option.match({
      onNone: Function.constant(Effect.succeed(Layer.empty)),
      onSome: (configured) => pipe(
        bundleAdminClient(),
        Effect.map((javascript) => {
          const adminOptions = typeof configured === "boolean" ? {} : configured
          return ApplicationAdmin.layerHttp({ application, javascript, ...adminOptions })
        }),
      ),
    }),
  )

  const routes = pipe(
    Layer.mergeAll(rpc, mcp, admin),
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
      const services = yield* pipe(
        Option.fromNullishOr(options.services),
        Option.getOrElse(Function.constant(Layer.empty)),
        Layer.build,
        Effect.provideContext(databaseContext),
      )
      const serviceContext = Context.merge(databaseContext, services)
      const initialize = pipe(Option.fromNullishOr(options.initialize), Option.getOrElse(Function.constant(Effect.void)))
      yield* Effect.provideContext(initialize, serviceContext)
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
  const sourceManifest = "manifest" in options.database ? Option.some(options.database.manifest) : Option.none()
  const manifest = pipe(
    sourceManifest,
    Option.map((value) => value instanceof URL ? Bun.fileURLToPath(value) : value),
  )

  const schema = SqliteMigrations.command({
    name: "schema",
    tables: application.tables,
    migrations,
    manifest,
  })

  const serve = () => serveApplication(application, options, manifest)
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

const run = Effect.fn("ApplicationBun.run")(function* <
  App extends Application,
  Services extends RuntimeLayer = Layer.Layer<never, never, never>,
  Initialize extends Initialization = Effect.Effect<void>,
>(application: App, options: RunOptions<Services, Initialize>) {
  const applicationRun = runApplication(application, options)
  return yield* pipe(
    applicationRun,
    Effect.provide(BunServices.layer),
  ) as Effect.Effect<void, RunErrors<App, Services, Initialize>, RunRequirements<App, Services, Initialize>>
})

const runMain = <
  App extends Application,
  Services extends RuntimeLayer = Layer.Layer<never, never, never>,
  Initialize extends Initialization = Effect.Effect<void>,
>(
  application: App,
  options: RunOptions<Services, Initialize> &
    ([RunRequirements<App, Services, Initialize>] extends [never] ? unknown : never),
): void => {
  const applicationRun = run(application, options)
  BunRuntime.runMain(applicationRun as Effect.Effect<void, RunErrors<App, Services, Initialize>>)
}

export const ApplicationBun = { run, runMain }
