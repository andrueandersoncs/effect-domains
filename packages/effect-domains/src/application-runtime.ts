import { Context, Effect, Layer, Schema, pipe } from "effect"
import { FetchHttpClient, HttpMiddleware, HttpRouter } from "effect/unstable/http"
import { type Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { Application, type ApplicationIR } from "./application.ts"
import { ApplicationUi, type ApplicationUiOptions } from "./application-ui.ts"
import { ApplicationTelemetry, type TelemetryOptions } from "./application-telemetry.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
import { RpcMcp } from "./rpc-mcp.ts"
import { SchemaStore } from "./migrations.ts"

export type RuntimeLayer = Layer.Layer<never, unknown, unknown>
type DatabaseLayer<E, R> = Layer.Layer<SchemaStore, E, R>
export type Initialization = Effect.Effect<void, unknown, unknown>

export type ApplicationRuntimeOptions<
  Services extends RuntimeLayer = Layer.Layer<never, never, never>,
  Initialize extends Initialization = Effect.Effect<void>,
  Background extends RuntimeLayer = Layer.Layer<never, never, never>,
> = Readonly<{
  services?: Services
  initialize?: Initialize
  background?: Background
}>

type HttpEndpointOptions = Readonly<{ path: `/${string}` }>
type HttpUiAssets = Readonly<{ javascript: string; stylesheet: string }>
type RoutesHttpOptions<Routes extends RuntimeLayer> = Readonly<{ routes?: Routes }>
type RpcHttpOptions = Readonly<{ rpc?: false | HttpEndpointOptions }>
type McpHttpOptions = Readonly<{ mcp?: false | HttpEndpointOptions }>
type UiHttpOptions = Readonly<{
  ui?: false | true | ApplicationUiOptions
  uiAssets?: HttpUiAssets
}>
type TelemetryHttpOptions = Readonly<{ telemetry?: false | TelemetryOptions }>

type HttpOptions<Routes extends RuntimeLayer = RuntimeLayer> =
  & RoutesHttpOptions<Routes>
  & RpcHttpOptions
  & McpHttpOptions
  & UiHttpOptions
  & TelemetryHttpOptions

export type ApplicationHttpOptions<
  Services extends RuntimeLayer = Layer.Layer<never, never, never>,
  Initialize extends Initialization = Effect.Effect<void>,
  Background extends RuntimeLayer = Layer.Layer<never, never, never>,
  Routes extends RuntimeLayer = Layer.Layer<never, never, never>,
> = ApplicationRuntimeOptions<Services, Initialize, Background> & HttpOptions<Routes>

class ApplicationUiAssetsUnavailable extends Schema.TaggedError<ApplicationUiAssetsUnavailable>()(
  "ApplicationUiAssetsUnavailable",
  {},
) {
  override get message() {
    return "Application UI assets are required when the generated UI is enabled"
  }
}

type ResolvedEndpoint =
  | Readonly<{ enabled: false }>
  | Readonly<{ enabled: true; path: `/${string}` }>

type ResolvedUi =
  | Readonly<{ enabled: false }>
  | Readonly<{
    enabled: true
    assets: HttpUiAssets | undefined
    presentation: ApplicationUiOptions
  }>

type ResolvedTelemetry = Readonly<{
  enabled: boolean
  options: TelemetryOptions | undefined
}>

type ResolvedHttpOptions<Routes extends RuntimeLayer> = Readonly<{
  routes: Routes | undefined
  rpc: ResolvedEndpoint
  mcp: ResolvedEndpoint
  ui: ResolvedUi
  telemetry: ResolvedTelemetry
}>

const resolveEndpoint = (
  setting: false | HttpEndpointOptions | undefined,
  defaultPath: `/${string}`,
): ResolvedEndpoint => {
  if (setting === false) return { enabled: false }
  if (setting === undefined) return { enabled: true, path: defaultPath }

  return { enabled: true, path: setting.path }
}

const resolveUi = (
  setting: false | true | ApplicationUiOptions | undefined,
  assets: HttpUiAssets | undefined,
): ResolvedUi => {
  if (setting === undefined || setting === false) return { enabled: false }
  if (setting === true) return { enabled: true, assets, presentation: {} }

  return { enabled: true, assets, presentation: setting }
}

const resolveTelemetry = (
  setting: false | TelemetryOptions | undefined,
): ResolvedTelemetry => {
  if (setting === false) return { enabled: false, options: undefined }

  return { enabled: true, options: setting }
}

const resolveHttpOptions = <Routes extends RuntimeLayer>(
  options: HttpOptions<Routes>,
): ResolvedHttpOptions<Routes> => ({
  routes: options.routes,
  rpc: resolveEndpoint(options.rpc, "/rpc/v1"),
  mcp: resolveEndpoint(options.mcp, "/mcp"),
  ui: resolveUi(options.ui, options.uiAssets),
  telemetry: resolveTelemetry(options.telemetry),
})

const buildContext = Effect.fn("ApplicationRuntime.buildContext")(function* <
  DatabaseError,
  DatabaseRequirements,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Background extends RuntimeLayer,
>(
  application: ApplicationIR,
  database: DatabaseLayer<DatabaseError, DatabaseRequirements>,
  options: ApplicationRuntimeOptions<Services, Initialize, Background>,
) {
  const databaseContext = yield* Layer.build(database)
  const schemaStore = Context.get(databaseContext, SchemaStore)

  yield* Application.prepare(application, schemaStore)

  const serviceLayer = options.services ?? Layer.empty

  const services = yield* pipe(
    Layer.build(serviceLayer),
    Effect.provideContext(databaseContext),
  )

  const serviceContext = Context.merge(databaseContext, services)
  const initialize = options.initialize ?? Effect.void

  yield* Effect.provideContext(initialize, serviceContext)

  const backgroundLayer = options.background ?? Layer.empty

  const background = yield* pipe(
    Layer.build(backgroundLayer),
    Effect.provideContext(serviceContext),
  )

  return Context.merge(serviceContext, background)
})

const buildUiLayer = Effect.fn("ApplicationRuntime.uiLayer")(function* (
  application: ApplicationIR,
  ui: ResolvedUi,
  telemetry: ResolvedTelemetry,
) {
  if (!ui.enabled) return Layer.empty

  if (ui.assets === undefined) {
    return yield* ApplicationUiAssetsUnavailable.make({})
  }

  return ApplicationUi.layerHttp({
    application,
    ...ui.assets,
    ...ui.presentation,
    telemetry: telemetry.options,
  })
})

const buildRpcLayer = (
  application: ApplicationIR,
  rpc: ResolvedEndpoint,
) => {
  if (!rpc.enabled) return Layer.empty

  return RpcServer.layerHttp({
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    group: application.group as RpcGroup.RpcGroup<Rpc.AnyWithProps>,
    path: rpc.path,
    protocol: "http",
  })
}

const buildMcpLayer = (
  application: ApplicationIR,
  mcp: ResolvedEndpoint,
) => {
  if (!mcp.enabled) return Layer.empty

  return RpcMcp.layerHttp({ application, path: mcp.path })
}

const buildHttpLayer = Effect.fn("ApplicationRuntime.buildHttpLayer")(function* <
  Routes extends RuntimeLayer,
>(
  application: ApplicationIR,
  options: ResolvedHttpOptions<Routes>,
) {
  const rpc = buildRpcLayer(application, options.rpc)
  const mcp = buildMcpLayer(application, options.mcp)
  const ui = yield* buildUiLayer(application, options.ui, options.telemetry)
  const routes = options.routes ?? Layer.empty
  const merged = Layer.mergeAll(rpc, mcp, ui, routes)
  const withHandlers = Layer.provideMerge(merged, application.handlers)
  const withAuthorization = Layer.provide(withHandlers, AuthorizationRpc.layer)
  const withSerialization = Layer.provide(withAuthorization, RpcSerialization.layerJson)

  return Layer.provide(withSerialization, FetchHttpClient.layer)
})

export const httpLayer = Effect.fn("ApplicationRuntime.httpLayer")(function* <
  Routes extends RuntimeLayer,
>(
  application: ApplicationIR,
  options: HttpOptions<Routes>,
) {
  const resolved = resolveHttpOptions(options)
  return yield* buildHttpLayer(application, resolved)
})

export const httpEffect = Effect.fn("ApplicationRuntime.httpEffect")(function* <
  DatabaseError,
  DatabaseRequirements,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Background extends RuntimeLayer,
  Routes extends RuntimeLayer,
>(
  application: ApplicationIR,
  database: DatabaseLayer<DatabaseError, DatabaseRequirements>,
  options: ApplicationHttpOptions<Services, Initialize, Background, Routes>,
) {
  const runtimeContext = yield* buildContext(application, database, options)
  const resolved = resolveHttpOptions(options)
  const routes = yield* buildHttpLayer(application, resolved)
  const runtimeLayer = Layer.succeedContext(runtimeContext)
  const providedRoutes = Layer.provide(routes, runtimeLayer)

  if (!resolved.telemetry.enabled) {
    return yield* HttpRouter.toHttpEffect(providedRoutes)
  }

  const telemetryMiddleware = HttpRouter.middleware(
    ApplicationTelemetry.httpMiddleware,
    { global: true },
  )
  const applicationLayer = Layer.merge(providedRoutes, telemetryMiddleware)
  const handler = yield* HttpRouter.toHttpEffect(applicationLayer)
  const tracerDisabled = Layer.succeed(HttpMiddleware.TracerDisabledWhen, () => true)

  return yield* Effect.provide(handler, tracerDisabled)
})

export const use = Effect.fn("ApplicationRuntime.use")(function* <
  DatabaseError,
  DatabaseRequirements,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Background extends RuntimeLayer,
  A,
  E,
  R,
>(
  application: ApplicationIR,
  database: DatabaseLayer<DatabaseError, DatabaseRequirements>,
  options: ApplicationRuntimeOptions<Services, Initialize, Background>,
  effect: Effect.Effect<A, E, R>,
) {
  const runtimeContext = yield* buildContext(application, database, options)

  return yield* Effect.provideContext(effect, runtimeContext)
})

