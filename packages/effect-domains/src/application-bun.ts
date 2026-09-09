import { BunHttpServer, BunServices } from "@effect/platform-bun"
import { AdminAssetFiles } from "@effect-domains/admin/assets"
import { Array, Config, Context, Effect, Layer, Option, type PlatformError, Predicate, type Redacted, Schema, type Scope, Stdio, Stream, pipe } from "effect"
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
    | Readonly<{ manifest: string | URL } & Partial<{ filename: string }>>
    | Readonly<{ migrations: ReadonlyArray<SqliteMigration> } & Partial<{ filename: string }>>
}> & Readonly<Partial<{
  services: Services
  initialize: Initialize
  admin: true | AdminOptions
}>>

type ProvidedRuntime = Layer.Success<ReturnType<typeof SqliteBunRuntime.sqlClient>> | BunServices.BunServices | Scope.Scope

type RunRequirements<App extends Application, Services extends RuntimeLayer, Initialize extends Initialization> =
  | Exclude<Layer.Services<Services>, ProvidedRuntime>
  | Exclude<Layer.Services<App["handlers"]> | Effect.Services<Initialize>, ProvidedRuntime | Layer.Success<Services>>
  | Exclude<Rpc.ServicesClient<RpcGroup.Rpcs<App["group"]>> | Rpc.ServicesServer<RpcGroup.Rpcs<App["group"]>> | Rpc.MiddlewareClient<RpcGroup.Rpcs<App["group"]>>, BunServices.BunServices | Scope.Scope>


class AdminAssetsError extends Schema.TaggedError<AdminAssetsError>()(
  "ApplicationBunAdminAssetsError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

type RunErrors<App extends Application, Services extends RuntimeLayer, Initialize extends Initialization> =
  | AdminAssetsError
  | Config.ConfigError | MigrationError | PlatformError.PlatformError | Schema.SchemaError | CliError.CliError
  | Layer.Error<ReturnType<typeof BunHttpServer.layer>> | Layer.Error<ReturnType<typeof SqliteBunRuntime.sqlClient>>
  | Layer.Error<ReturnType<typeof RpcMcp.layerHttp>> | Layer.Error<ReturnType<typeof ApplicationAdmin.layerHttp>>
  | Layer.Error<App["handlers"]>
  | Layer.Error<Services> | Effect.Error<Initialize>

const environmentPrefix = (name: string) => name.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")
const manifestPath = (manifest: string | URL) => manifest instanceof URL ? Bun.fileURLToPath(manifest) : manifest

const databaseFilename = (name: string, configured: Option.Option<string>) => {
  const environment = environmentPrefix(name)

  return Option.match(configured, {
    onNone: () => pipe(Config.schema(Schema.NonEmptyString, `${environment}_DB`), Config.withDefault(`${name}.sqlite`)),
    onSome: Effect.succeed,
  })
}

const readAdminAsset = (file: URL) => Effect.tryPromise({
  try: () => Bun.file(file).text(),
  catch: (cause) => AdminAssetsError.make({
    reason: `Could not read prebuilt admin asset ${file.pathname}. Run \`bun run build\` before serving with admin enabled. ${String(cause)}`,
  }),
})

const readAdminAssets = Effect.fn("ApplicationBun.readAdminAssets")(function* () {
  const javascript = readAdminAsset(AdminAssetFiles.javascript)
  const stylesheet = readAdminAsset(AdminAssetFiles.stylesheet)
  return yield* Effect.all({ javascript, stylesheet }, { concurrency: "unbounded" })
})

const serveApplication = Effect.fn("ApplicationBun.serve")(function* <
  App extends Application,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
>(application: App, options: RunOptions<Services, Initialize>) {
  const configuredFilename = Option.fromNullishOr(options.database.filename)
  const filename = yield* databaseFilename(application.name, configuredFilename)

  const migrations = yield* ("migrations" in options.database
    ? Effect.succeed(options.database.migrations)
    : pipe(manifestPath(options.database.manifest), SqliteMigrations.load))

  const port = yield* pipe(Config.port("PORT"), Config.withDefault(3000))
  const database = SqliteBunRuntime.sqlClient(filename, { migrations })
  const rpc = RpcServer.layerHttp({ group: application.group as RpcGroup.RpcGroup<Rpc.AnyWithProps>, path: "/rpc/v1", protocol: "http" })
  const mcp = RpcMcp.layerHttp({ name: application.name, group: application.group as RpcGroup.RpcGroup<Rpc.AnyWithProps>, path: "/mcp" })

  const admin = yield* pipe(
    Option.fromNullishOr(options.admin),
    Option.match({
      onNone: () => Effect.succeed(Layer.empty),
      onSome: Effect.fn("ApplicationBun.admin")(function* (configuration) {
        const assets = yield* readAdminAssets()
        const presentation = Predicate.isBoolean(configuration) ? {} : configuration
        return ApplicationAdmin.layerHttp({ application, ...assets, ...presentation })
      }),
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
        Layer.build(options.services ?? Layer.empty),
        Effect.provideContext(databaseContext),
      )

      const serviceContext = Context.merge(databaseContext, services)
      yield* Effect.provideContext(options.initialize ?? Effect.void, serviceContext)
      return yield* pipe(Layer.launch(server), Effect.provideContext(serviceContext))
    }),
    Effect.scoped,
  )
})

const inspectCommand = (application: Application) => {
  const operation = pipe(Argument.string("operation"), Argument.optional)

  const inspect = Effect.fn("ApplicationBun.inspect")(function* ({ operation }: Readonly<{ operation: Option.Option<string> }>) {
    const inspection = ApplicationInspect.describe(application, operation)
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
  App extends Application,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
>(application: App, options: RunOptions<Services, Initialize>) {
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

  const manifest = "manifest" in options.database ? pipe(manifestPath(options.database.manifest), Option.some) : Option.none()

  const schema = SqliteMigrations.command({
    name: "schema",
    tables: application.tables,
    manifest,
  })

  const serveCommand = Command.make("serve", {}, () => serveApplication(application, options))
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
    Services extends RuntimeLayer = Layer.Layer<never, never, never>,
    Initialize extends Initialization = Effect.Effect<void>,
  >(application: App, options: RunOptions<Services, Initialize>) {
    return yield* pipe(
      runApplication(application, options),
      Effect.provide(BunServices.layer),
    ) as Effect.Effect<void, RunErrors<App, Services, Initialize>, RunRequirements<App, Services, Initialize>>
  }),
}
