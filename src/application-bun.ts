import { BunHttpServer, BunServices } from "@effect/platform-bun"
import { Config, Context, Effect, Layer, type PlatformError, Schema, type Scope, pipe } from "effect"
import { Argument, CliError, Command } from "effect/unstable/cli"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { type Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import type { Application } from "./application.ts"
import { ApplicationInspect } from "./application-inspect.ts"
import { RpcCli } from "./rpc-cli.ts"
import { SqliteBunRuntime } from "./sqlite-bun.ts"
import { SqliteMigrations, type SqliteMigration } from "./sqlite-migrations.ts"
import { Table } from "./table.ts"
import type { MigrationError } from "./migrations.ts"

type DatabaseOptions =
  | Readonly<{
    manifest: string
    filename?: string
  }>
  | Readonly<{
    migrations: ReadonlyArray<SqliteMigration>
    filename?: string
    manifest?: never
  }>

type RuntimeLayer = Layer.Layer<any, any, any>
type Initialization = Effect.Effect<any, any, any>

type RunOptions<
  Services extends RuntimeLayer | undefined,
  Initialize extends Initialization | undefined,
> = Readonly<{
  database: DatabaseOptions
  services?: Services
  initialize?: Initialize
}>

type RuntimeApplication = Readonly<{
  name: string
  resources: Application["resources"]
  group: RpcGroup.RpcGroup<any>
  tables: ReadonlyArray<Table>
  handlers: RuntimeLayer
  prepare: Initialization
}>

type ProvidedRuntime = Layer.Success<ReturnType<typeof SqliteBunRuntime.sqlClient>> | BunServices.BunServices | Scope.Scope
type RunRequirements<App extends RuntimeApplication, Services extends RuntimeLayer | undefined, Initialize extends Initialization | undefined> =
  | Exclude<Effect.Services<App["prepare"]> | Layer.Services<NonNullable<Services>>, ProvidedRuntime>
  | Exclude<Layer.Services<App["handlers"]> | Effect.Services<NonNullable<Initialize>>, ProvidedRuntime | Layer.Success<NonNullable<Services>>>
  | Exclude<Rpc.ServicesClient<RpcGroup.Rpcs<App["group"]>> | Rpc.ServicesServer<RpcGroup.Rpcs<App["group"]>> | Rpc.MiddlewareClient<RpcGroup.Rpcs<App["group"]>>, BunServices.BunServices | Scope.Scope>

type RunErrors<App extends RuntimeApplication, Services extends RuntimeLayer | undefined, Initialize extends Initialization | undefined> =
  | Config.ConfigError | MigrationError | PlatformError.PlatformError | Schema.SchemaError | CliError.CliError
  | Layer.Error<ReturnType<typeof BunHttpServer.layer>> | Layer.Error<ReturnType<typeof SqliteBunRuntime.sqlClient>>
  | Layer.Error<App["handlers"]> | Effect.Error<App["prepare"]>
  | Layer.Error<NonNullable<Services>> | Effect.Error<NonNullable<Initialize>>

type InspectionApplication = Readonly<{
  name: string
  resources: Application["resources"]
  group: RpcGroup.RpcGroup<any>
}>

const databaseEnvironmentVariable = (application: Readonly<{ name: string }>) =>
  `${application.name.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_DB`

const serviceUrlEnvironmentVariable = (application: Readonly<{ name: string }>) =>
  `${application.name.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_URL`

const databaseFilename = (application: Readonly<{ name: string }>, configured?: string) =>
  configured === undefined
    ? pipe(
      Config.schema(Schema.NonEmptyString, databaseEnvironmentVariable(application)),
      Config.withDefault(`${application.name}.sqlite`),
    )
    : Effect.succeed(configured)

const serveApplication = Effect.fn("ApplicationBun.serve")(function* <
  App extends RuntimeApplication,
  Services extends RuntimeLayer | undefined = undefined,
  Initialize extends Initialization | undefined = undefined,
>(
  application: App,
  options: RunOptions<Services, Initialize>,
) {
  const filename = yield* databaseFilename(application, options.database.filename)
  const migrations = "migrations" in options.database
    ? options.database.migrations
    : yield* SqliteMigrations.load(options.database.manifest)
  const port = yield* pipe(Config.port("PORT"), Config.withDefault(3000))
  const database = SqliteBunRuntime.sqlClient(filename, { migrations })

  const routes = pipe(
    RpcServer.layerHttp({
      group: application.group,
      path: "/rpc/v1",
      protocol: "http",
    }),
    Layer.provide(application.handlers),
    Layer.provide(RpcSerialization.layerJson),
  )
  const server = pipe(
    HttpRouter.serve(routes),
    Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port })),
  )

  return yield* Effect.scoped(Effect.gen(function* () {
    const databaseContext = yield* Layer.build(database)
    yield* Effect.provideContext(application.prepare, databaseContext)

    const serviceContext = options.services === undefined
      ? databaseContext
      : yield* pipe(
        Layer.build(options.services),
        Effect.provideContext(databaseContext),
        Effect.map((services) => Context.merge(databaseContext, services)),
      )

    if (options.initialize !== undefined) {
      yield* Effect.provideContext(options.initialize, serviceContext)
    }

    return yield* Effect.provideContext(Layer.launch(server), serviceContext)
  }))
})

const inspectCommand = (application: InspectionApplication) => {
  const operation = pipe(Argument.string("operation"), Argument.optional)

  return Command.make("inspect", { operation }, ({ operation }) => {
    const selected = operation._tag === "Some" ? operation.value : undefined
    const inspection = ApplicationInspect.describe(application, selected)
    if (selected !== undefined && inspection.operations.length === 0) {
      return CliError.UserError.make({
        cause: selected,
        userMessage: `Unknown application operation ${selected}`,
      })
    }

    return Effect.sync(() => {
      process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`)
    })
  })
}

const runApplication = Effect.fn("ApplicationBun.run")(function* <
  App extends RuntimeApplication,
  Services extends RuntimeLayer | undefined = undefined,
  Initialize extends Initialization | undefined = undefined,
>(
  application: App,
  options: RunOptions<Services, Initialize>,
) {
  const protocol = Layer.unwrap(pipe(
    Config.schema(Schema.URLFromString, serviceUrlEnvironmentVariable(application)),
    Config.withDefault(new URL("http://127.0.0.1:3000/rpc/v1")),
    Effect.map((url) => pipe(
      RpcClient.layerProtocolHttp({ url: url.href }),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(RpcSerialization.layerJson),
    )),
  ))
  const schema = SqliteMigrations.command({
    name: "schema",
    tables: application.tables,
    migrations: "migrations" in options.database ? options.database.migrations : undefined,
    manifest: options.database.manifest,
  })
  const command = RpcCli.make({
    name: application.name,
    group: application.group,
    protocol,
    subcommands: [
      Command.make("serve", {}, () => serveApplication(application, options)),
      schema,
      inspectCommand(application),
    ],
  })

  return yield* Command.run(command, { version: "0.1.0" })
})

export const ApplicationBun = {
  run: <
    App extends RuntimeApplication,
    Services extends RuntimeLayer | undefined = undefined,
    Initialize extends Initialization | undefined = undefined,
  >(
    application: App,
    options: RunOptions<Services, Initialize>,
  ) => pipe(
    runApplication(application, options),
    Effect.provide(BunServices.layer),
  // The branches share one runtime scope; retain each caller's concrete dependency graph.
  ) as Effect.Effect<void, RunErrors<App, Services, Initialize>, RunRequirements<App, Services, Initialize>>,
}
