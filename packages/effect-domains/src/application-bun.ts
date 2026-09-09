import { BunHttpServer, BunServices } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { AdminAssetFiles } from "@effect-domains/admin/assets"
import { Array, Config, Context, Effect, Equivalence, FileSystem, Layer, Match, Option, Path, type PlatformError, Predicate, type Redacted, Schema, type Scope, Stdio, Stream, pipe } from "effect"
import { Argument, CliError, Command } from "effect/unstable/cli"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { type Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { SqlClient } from "effect/unstable/sql"
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
  Execution extends RuntimeLayer = Layer.Layer<never, never, never>,
  Background extends RuntimeLayer = Layer.Layer<never, never, never>,
  Routes extends RuntimeLayer = Layer.Layer<never, never, never>,
> = Readonly<{
  database:
    | Readonly<{ manifest: string | URL } & Partial<{ filename: string }>>
    | Readonly<{ migrations: ReadonlyArray<SqliteMigration> } & Partial<{ filename: string }>>
}> & Readonly<Partial<{
  services: Services
  initialize: Initialize
  execution: Readonly<{ database: string | URL; layer: Execution }>
  background: Background
  routes: Routes
  admin: true | AdminOptions
}>>

type InfrastructureSql = SqlClient.SqlClient | SqliteClient.SqliteClient
type ProvidedRuntime = Layer.Success<ReturnType<typeof SqliteBunRuntime.sqlClient>> | BunServices.BunServices | Scope.Scope

type ExecutionRequirements<Execution extends RuntimeLayer> =
  Exclude<Layer.Services<Execution>, BunServices.BunServices | Scope.Scope | InfrastructureSql>

type ExecutionServices<Execution extends RuntimeLayer> = Exclude<Layer.Success<Execution>, InfrastructureSql>

type ServiceRuntime<Services extends RuntimeLayer, Execution extends RuntimeLayer> =
  ProvidedRuntime | ExecutionServices<Execution> | Layer.Success<Services>

type RouteRuntime<
  App extends Application,
  Services extends RuntimeLayer,
  Execution extends RuntimeLayer,
  Background extends RuntimeLayer,
> = ServiceRuntime<Services, Execution> | Layer.Success<App["handlers"]> | Layer.Success<Background> | HttpRouter.HttpRouter

type RouteRequirements<Routes extends RuntimeLayer> =
  | HttpRouter.Request.Without<Layer.Services<Routes>>
  | Exclude<HttpRouter.Request.Only<"Requires", Layer.Services<Routes>> | HttpRouter.Request.Only<"GlobalRequires", Layer.Services<Routes>>, HttpRouter.GlobalProvided>

type RunRequirements<
  App extends Application,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Execution extends RuntimeLayer,
  Background extends RuntimeLayer,
  Routes extends RuntimeLayer,
> =
  | ExecutionRequirements<Execution>
  | Exclude<Layer.Services<Services>, ProvidedRuntime | ExecutionServices<Execution>>
  | Exclude<Effect.Services<Initialize> | Layer.Services<Background>, ServiceRuntime<Services, Execution>>
  | Exclude<Layer.Services<App["handlers"]> | RouteRequirements<Routes>, RouteRuntime<App, Services, Execution, Background>>
  | Exclude<Rpc.Middleware<RpcGroup.Rpcs<App["group"]>>, RouteRuntime<App, Services, Execution, Background> | AuthorizationRpc>
  | Exclude<Rpc.ServicesClient<RpcGroup.Rpcs<App["group"]>> | Rpc.ServicesServer<RpcGroup.Rpcs<App["group"]>> | Rpc.MiddlewareClient<RpcGroup.Rpcs<App["group"]>>, BunServices.BunServices | Scope.Scope>

class AdminAssetsError extends Schema.TaggedError<AdminAssetsError>()(
  "ApplicationBunAdminAssetsError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

class ExecutionDatabaseError extends Schema.TaggedError<ExecutionDatabaseError>()(
  "ApplicationBunExecutionDatabaseError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

class ExecutionDatabaseConflictError extends Schema.TaggedError<ExecutionDatabaseConflictError>()(
  "ApplicationBunExecutionDatabaseConflictError",
  { application: Schema.String, execution: Schema.String },
) {
  override get message() {
    return `Application and execution databases must be distinct: ${this.application}`
  }
}

type RunErrors<
  App extends Application,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Execution extends RuntimeLayer,
  Background extends RuntimeLayer,
  Routes extends RuntimeLayer,
> =
  | AdminAssetsError | ExecutionDatabaseError | ExecutionDatabaseConflictError
  | Config.ConfigError | MigrationError | PlatformError.PlatformError | Schema.SchemaError | CliError.CliError
  | Layer.Error<ReturnType<typeof BunHttpServer.layer>> | Layer.Error<ReturnType<typeof SqliteBunRuntime.sqlClient>>
  | Layer.Error<ReturnType<typeof RpcMcp.layerHttp>> | Layer.Error<ReturnType<typeof ApplicationAdmin.layerHttp>>
  | Layer.Error<App["handlers"]>
  | Layer.Error<Services> | Effect.Error<Initialize> | Layer.Error<Execution> | Layer.Error<Background> | Layer.Error<Routes>

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

const sameString = Equivalence.strictEqual<string>()

const databasePathFromUrl = Effect.fn("ApplicationBun.databasePathFromUrl")(function* (url: URL) {
  const fileProtocol = sameString(url.protocol, "file:")

  if (!fileProtocol) {
    return yield* ExecutionDatabaseError.make({
      reason: `Execution database URLs must use the file: protocol: ${url.href}`,
    })
  }

  const hasQuery = Boolean(url.search)

  if (hasQuery) {
    return yield* ExecutionDatabaseError.make({ reason: "Database file URLs cannot contain query parameters or fragments" })
  }

  const hasFragment = Boolean(url.hash)

  if (hasFragment) {
    return yield* ExecutionDatabaseError.make({ reason: "Database file URLs cannot contain query parameters or fragments" })
  }

  const path = yield* Path.Path
  return yield* path.fromFileUrl(url)
})

const executionDatabaseFilename = (database: string | URL) => pipe(
  Match.value(database),
  Match.when(Predicate.isString, (filename) => {
    const sqliteUri = filename.startsWith("file:")
    const fileUrl = filename.startsWith("file://")
    const notFileUrl = !fileUrl
    const unsupportedUri = sqliteUri && notFileUrl

    if (unsupportedUri) {
      return ExecutionDatabaseError.make({ reason: "Use a filesystem path or a file:// URL, not a SQLite URI filename" })
    }

    if (!fileUrl) return Effect.succeed(filename)

    const url = Effect.try({
      try: () => new URL(filename),
      catch: (cause) => ExecutionDatabaseError.make({
        reason: `Invalid execution database URL ${filename}: ${String(cause)}`,
      }),
    })

    return pipe(url, Effect.andThen(databasePathFromUrl))
  }),
  Match.orElse(databasePathFromUrl),
)

const isMissingPath = (cause: PlatformError.PlatformError) => sameString(cause.reason._tag, "NotFound")

const canonicalExistingAncestor = Effect.fn("ApplicationBun.canonicalExistingAncestor")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  candidate: string,
  missing: ReadonlyArray<string>,
): Effect.fn.Return<string, PlatformError.PlatformError | ExecutionDatabaseError> {
  const exists = yield* fileSystem.exists(candidate)

  if (exists) {
    const resolved = yield* fileSystem.realPath(candidate)
    return path.join(resolved, ...missing)
  }

  const danglingLink = yield* pipe(
    fileSystem.readLink(candidate),
    Effect.as(true),
    Effect.catchIf(isMissingPath, () => Effect.succeed(false)),
  )

  if (danglingLink) {
    return yield* ExecutionDatabaseError.make({ reason: `Database paths cannot traverse dangling symlinks: ${candidate}` })
  }

  const parent = path.dirname(candidate)
  const reachedRoot = sameString(parent, candidate)
  if (reachedRoot) return path.join(candidate, ...missing)

  const component = path.basename(candidate)
  const remaining = [component, ...missing]
  return yield* canonicalExistingAncestor(fileSystem, path, parent, remaining)
})

const canonicalDatabasePath = Effect.fn("ApplicationBun.canonicalDatabasePath")(function* (database: string | URL) {
  const location = yield* executionDatabaseFilename(database)
  const inMemory = sameString(location, ":memory:")
  if (inMemory) return Option.none<string>()

  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const resolvedLocation = path.resolve(location)
  const canonical = yield* canonicalExistingAncestor(fileSystem, path, resolvedLocation, [])
  return Option.some(canonical)
})

const sameDatabaseFile = Effect.fn("ApplicationBun.sameDatabaseFile")(function* (application: string, execution: string) {
  const samePath = sameString(application, execution)
  if (samePath) return samePath

  const fileSystem = yield* FileSystem.FileSystem
  const applicationExists = yield* fileSystem.exists(application)
  if (!applicationExists) return applicationExists

  const executionExists = yield* fileSystem.exists(execution)
  if (!executionExists) return executionExists

  const applicationInfo = yield* fileSystem.stat(application)
  const executionInfo = yield* fileSystem.stat(execution)
  const sameDevice = Equivalence.strictEqual<number>()(applicationInfo.dev, executionInfo.dev)
  if (!sameDevice) return sameDevice

  const matchesInode = (applicationInode: number) => Option.exists(
    executionInfo.ino,
    (executionInode) => Equivalence.strictEqual<number>()(applicationInode, executionInode),
  )

  return Option.exists(applicationInfo.ino, matchesInode)
})

const assertDistinctDatabases = Effect.fn("ApplicationBun.assertDistinctDatabases")(function* (
  application: string,
  execution: string | URL,
) {
  const applicationPath = yield* canonicalDatabasePath(application)
  if (Option.isNone(applicationPath)) return

  const executionPath = yield* canonicalDatabasePath(execution)
  if (Option.isNone(executionPath)) return

  const sameFile = yield* sameDatabaseFile(applicationPath.value, executionPath.value)
  if (!sameFile) return

  return yield* ExecutionDatabaseConflictError.make({
    application: applicationPath.value,
    execution: executionPath.value,
  })
})

const withApplicationRuntime = Effect.fn("ApplicationBun.runtime")(function* <
  App extends Application,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Execution extends RuntimeLayer,
  Background extends RuntimeLayer,
  Routes extends RuntimeLayer,
>(
  application: App,
  options: RunOptions<Services, Initialize, Execution, Background, Routes>,
  use: Effect.Effect<unknown, unknown, any>,
) {
  const configuredFilename = Option.fromNullishOr(options.database.filename)
  const filename = yield* databaseFilename(application.name, configuredFilename)
  const execution = Option.fromNullishOr(options.execution)

  yield* Option.match(execution, {
    onNone: () => Effect.void,
    onSome: (configuration) => assertDistinctDatabases(filename, configuration.database),
  })

  const migrations = yield* ("migrations" in options.database
    ? Effect.succeed(options.database.migrations)
    : pipe(manifestPath(options.database.manifest), SqliteMigrations.load))

  const database = SqliteBunRuntime.sqlClient(filename, { migrations })
  const databaseContext = yield* Layer.build(database)
  yield* pipe(Application.prepare(application), Effect.provideContext(databaseContext))

  const executionContext = yield* Option.match(execution, {
    onNone: () => Effect.sync(Context.empty),
    onSome: Effect.fn("ApplicationBun.execution")(function* (configuration) {
      const executionFilename = yield* executionDatabaseFilename(configuration.database)
      const executionDatabase = SqliteClient.layer({ filename: executionFilename })
      const executionLayer = pipe(configuration.layer, Layer.provide(executionDatabase))
      const executionServices = yield* Layer.build(executionLayer)
      return pipe(executionServices, Context.omit(SqlClient.SqlClient, SqliteClient.SqliteClient))
    }),
  })

  const infrastructureContext = Context.merge(databaseContext, executionContext)

  const services = yield* pipe(
    Layer.build(options.services ?? Layer.empty),
    Effect.provideContext(infrastructureContext),
  )

  const serviceContext = Context.merge(infrastructureContext, services)
  yield* Effect.provideContext(options.initialize ?? Effect.void, serviceContext)

  const background = yield* pipe(
    Layer.build(options.background ?? Layer.empty),
    Effect.provideContext(serviceContext),
  )

  const runtimeContext = Context.merge(serviceContext, background)
  return yield* pipe(use, Effect.provideContext(runtimeContext))
})

const serveApplication = Effect.fn("ApplicationBun.serve")(function* <
  App extends Application,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Execution extends RuntimeLayer,
  Background extends RuntimeLayer,
  Routes extends RuntimeLayer,
>(application: App, options: RunOptions<Services, Initialize, Execution, Background, Routes>) {
  const port = yield* pipe(Config.port("PORT"), Config.withDefault(3000))
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
    Layer.mergeAll(rpc, mcp, admin, options.routes ?? Layer.empty),
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

const workerLifetime = (name: string) => {
  const ready = Effect.log(`Worker ready: ${name}`)
  return Effect.andThen(ready, Effect.never)
}

const workerApplication = Effect.fn("ApplicationBun.worker")(function* <
  App extends Application,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Execution extends RuntimeLayer,
  Background extends RuntimeLayer,
  Routes extends RuntimeLayer,
>(application: App, options: RunOptions<Services, Initialize, Execution, Background, Routes>) {
  const lifetime = workerLifetime(application.name)

  return yield* pipe(
    withApplicationRuntime(application, options, lifetime),
    Effect.scoped,
  )

})

const inspectCommand = (application: Application, localCommands: ReadonlyArray<string>) => {
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
  App extends Application,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Execution extends RuntimeLayer,
  Background extends RuntimeLayer,
  Routes extends RuntimeLayer,
>(application: App, options: RunOptions<Services, Initialize, Execution, Background, Routes>) {
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
  const background = Option.fromNullishOr(options.background)

  const localCommands = Option.match(background, {
    onNone: () => ["serve", "schema", "inspect"],
    onSome: () => ["serve", "worker", "schema", "inspect"],
  })

  const inspection = inspectCommand(application, localCommands)

  const subcommands = Option.match(background, {
    onNone: () => [serveCommand, schema, inspection],
    onSome: () => {
      const workerCommand = Command.make("worker", {}, () => workerApplication(application, options))
      return [serveCommand, workerCommand, schema, inspection]
    },
  })

  const command = RpcCli.make({
    name: application.name,
    group: application.group,
    protocol,
    subcommands,
  })

  return yield* Command.run(command, { version: "0.1.0" })
})

export const ApplicationBun = {
  run: Effect.fn("ApplicationBun.run")(function* <
    App extends Application,
    Services extends RuntimeLayer = Layer.Layer<never, never, never>,
    Initialize extends Initialization = Effect.Effect<void>,
    Execution extends RuntimeLayer = Layer.Layer<never, never, never>,
    Background extends RuntimeLayer = Layer.Layer<never, never, never>,
    Routes extends RuntimeLayer = Layer.Layer<never, never, never>,
  >(application: App, options: RunOptions<Services, Initialize, Execution, Background, Routes>) {
    return yield* pipe(
      runApplication(application, options),
      Effect.provide(BunServices.layer),
    ) as Effect.Effect<
      void,
      RunErrors<App, Services, Initialize, Execution, Background, Routes>,
      RunRequirements<App, Services, Initialize, Execution, Background, Routes>
    >
  }),
}
