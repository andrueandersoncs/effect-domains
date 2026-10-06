import { Context, Data, Effect, Function, Layer, Option, Predicate, Record, Schema, type Scope, pipe } from "effect"
import { FetchHttpClient, HttpMiddleware, HttpRouter } from "effect/unstable/http"
import { type RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { Application, type ApplicationIR } from "./index.ts"
import { ApplicationUi, type ApplicationUiAssets, type ApplicationUiOptions } from "./ui/index.ts"
import { ApplicationTelemetry } from "./telemetry/index.ts"
import type { TelemetryOptions } from "./telemetry/config.ts"
import { AuthorizationRpc } from "../authorization/rpc.ts"
import { RpcMcp } from "../rpc/mcp.ts"
import { type MigrationError, SchemaStore } from "../sqlite/schema-store.ts"

export type RuntimeLayer = Layer.Any

type RuntimeLayerValue<Runtime extends RuntimeLayer> = Layer.Layer<
  Layer.Success<Runtime>,
  Layer.Error<Runtime>,
  Layer.Services<Runtime>
>

type DatabaseLayer<Database extends RuntimeLayer> = Layer.Layer<SchemaStore | Layer.Success<Database>, Layer.Error<Database>, Layer.Services<Database>>
export type Initialization = Effect.Effect<void, any, any>

type RequiredRuntimeLayerOption<Key extends string, Runtime extends RuntimeLayer> =
  [Layer.Success<Runtime>] extends [never]
    ? Readonly<Record<never, never>>
    : Readonly<Record<Key, Runtime & RuntimeLayerValue<Runtime>>>

export type ApplicationRuntimeOptions<
  Services extends RuntimeLayer = Layer.Layer<never, never, never>,
  Initialize extends Initialization = Effect.Effect<void>,
  Background extends RuntimeLayer = Layer.Layer<never, never, never>,
> = Readonly<Partial<{
  services: Services & RuntimeLayerValue<Services>
  initialize: Initialize & Effect.Effect<void, Effect.Error<Initialize>, Effect.Services<Initialize>>
  background: Background & RuntimeLayerValue<Background>
}>> & RequiredRuntimeLayerOption<"services", Services> & RequiredRuntimeLayerOption<"background", Background>

type HttpEndpointOptions = Readonly<{ path: `/${string}` }>
type RoutesHttpOptions<Routes extends RuntimeLayer> = Readonly<Partial<{ routes: Routes & RuntimeLayerValue<Routes> }>>

type RpcHttpOptions = Readonly<Partial<{ rpc: false | HttpEndpointOptions }>>
type McpHttpOptions = Readonly<Partial<{ mcp: false | HttpEndpointOptions }>>

type UiHttpOptions = Readonly<Partial<{
  ui: false | true | ApplicationUiOptions
  uiAssets: ApplicationUiAssets
}>>

type TelemetryHttpOptions = Readonly<Partial<{ telemetry: false | TelemetryOptions }>>

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

export class ApplicationUiAssetsUnavailable extends Schema.TaggedError<ApplicationUiAssetsUnavailable>()(
  "ApplicationUiAssetsUnavailable",
  {},
) {
  override get message() {
    return "Application UI assets are required when the generated UI is enabled"
  }
}

const disabledUi = Option.none<ApplicationUiOptions>()
const emptyUiOptions: ApplicationUiOptions = Record.empty()
const defaultUi = Option.some(emptyUiOptions)
const emptyTelemetryOptions: TelemetryOptions = Record.empty()
const defaultTelemetry = Option.some(emptyTelemetryOptions)

class ResolvedHttpOptions<Routes extends RuntimeLayer> extends Data.Class<Readonly<{
  routes: Option.Option<RuntimeLayerValue<Routes>>
  rpc: Option.Option<`/${string}`>
  mcp: Option.Option<`/${string}`>
  ui: Option.Option<ApplicationUiOptions>
  uiAssets: Option.Option<ApplicationUiAssets>
  telemetry: Option.Option<TelemetryOptions>
}>> {}

const resolveEndpoint = (
  setting: Option.Option<false | HttpEndpointOptions>,
  defaultPath: `/${string}`,
) =>
  Option.match(setting, {
    onNone: () => Option.some(defaultPath),
    onSome: (value) => Predicate.isBoolean(value) ? Option.none() : Option.some(value.path),
  })

const resolveTelemetry = (setting: Option.Option<false | TelemetryOptions>) =>
  Option.match(setting, {
    onNone: Function.constant(defaultTelemetry),
    onSome: (value) => Predicate.isBoolean(value) ? Option.none() : Option.some(value),
  })

const resolveHttpOptions = <Routes extends RuntimeLayer>(
  options: HttpOptions<Routes>,
) => {
  const routes = Option.fromUndefinedOr(options.routes)
  const rpcSetting = Option.fromUndefinedOr(options.rpc)
  const rpc = resolveEndpoint(rpcSetting, "/rpc/v1")
  const mcpSetting = Option.fromUndefinedOr(options.mcp)
  const mcp = resolveEndpoint(mcpSetting, "/mcp")
  const uiSetting = Option.fromUndefinedOr(options.ui)

  const ui = Option.match(uiSetting, {
    onNone: Function.constant(disabledUi),
    onSome: (value) => {
      if (!Predicate.isBoolean(value)) return Option.some(value)

      return value ? defaultUi : disabledUi
    },
  })

  const uiAssets = Option.fromUndefinedOr(options.uiAssets)
  const telemetrySetting = Option.fromUndefinedOr(options.telemetry)
  const telemetry = resolveTelemetry(telemetrySetting)

  return new ResolvedHttpOptions<Routes>({ routes, rpc, mcp, ui, uiAssets, telemetry })
}

const buildContext = Effect.fn("ApplicationRuntime.buildContext")(function* <
  Database extends RuntimeLayer,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Background extends RuntimeLayer,
>(
  application: ApplicationIR,
  database: Database & DatabaseLayer<Database>,
  options: ApplicationRuntimeOptions<Services, Initialize, Background>,
): Effect.fn.Return<
  Context.Context<SchemaStore | Layer.Success<Database> | Layer.Success<Services> | Layer.Success<Background>>,
  MigrationError | Layer.Error<Database> | Layer.Error<Services> | Effect.Error<Initialize> | Layer.Error<Background>,
  | Scope.Scope
  | Layer.Services<Database>
  | Exclude<Layer.Services<Services>, SchemaStore | Layer.Success<Database>>
  | Exclude<Effect.Services<Initialize> | Layer.Services<Background>, SchemaStore | Layer.Success<Database> | Layer.Success<Services>>
> {
  const databaseContext = yield* Layer.build<Layer.Services<Database>, Layer.Error<Database>, SchemaStore | Layer.Success<Database>>(database)
  const schemaStore = Context.get(databaseContext, SchemaStore)

  yield* Application.prepare(application, schemaStore)

  const services = Predicate.isUndefined(options.services) ? Context.empty() : yield* pipe(
    Layer.build<Layer.Services<Services>, Layer.Error<Services>, Layer.Success<Services>>(options.services),
    Effect.provideContext<SchemaStore | Layer.Success<Database>>(databaseContext),
  )

  type ServiceContext = SchemaStore | Layer.Success<Database> | Layer.Success<Services>

  // SAFETY: The merged context has these outputs because the options require every nonempty service layer.
  const serviceContext = Context.merge(databaseContext, services) as Context.Context<ServiceContext>

  if (!Predicate.isUndefined(options.initialize)) {
    yield* Effect.provideContext<void, Effect.Error<Initialize>, Effect.Services<Initialize>, ServiceContext>(options.initialize, serviceContext)
  }

  const background = Predicate.isUndefined(options.background) ? Context.empty() : yield* pipe(
    Layer.build<Layer.Services<Background>, Layer.Error<Background>, Layer.Success<Background>>(options.background),
    Effect.provideContext<ServiceContext>(serviceContext),
  )

  // SAFETY: The merged context has these outputs because the options require every nonempty background layer.
  return Context.merge(serviceContext, background) as Context.Context<ServiceContext | Layer.Success<Background>>
})

const buildUiLayer = Effect.fn("ApplicationRuntime.uiLayer")(function* <
  App extends ApplicationIR,
  Routes extends RuntimeLayer,
>(
  application: App,
  options: ResolvedHttpOptions<Routes>,
) {
  if (Option.isNone(options.ui)) return Layer.empty

  if (Option.isNone(options.uiAssets)) {
    return yield* ApplicationUiAssetsUnavailable.make({})
  }

  const telemetry = Option.getOrUndefined(options.telemetry)

  return ApplicationUi.layerHttp({
    application,
    ...options.uiAssets.value,
    ...options.ui.value,
    telemetry,
  })
})

const buildRpcLayer = <App extends ApplicationIR>(
  application: App,
  rpc: Option.Option<`/${string}`>,
) => Option.match(rpc, {
  onNone: Function.constant(Layer.empty),
  // SAFETY: The group retains its precise requirements because Application.compile assembled these procedures.
  onSome: (path) => RpcServer.layerHttp({
    group: application.group as App["group"] & RpcGroup.RpcGroup<RpcGroup.Rpcs<App["group"]>>,
    path,
    protocol: "http",
  }),
})

const buildMcpLayer = <App extends ApplicationIR>(
  application: App,
  mcp: Option.Option<`/${string}`>,
) => Option.match(mcp, {
  onNone: Function.constant(Layer.empty),
  onSome: (path) => RpcMcp.layerHttp({ application, path }),
})

const buildHttpLayer = Effect.fn("ApplicationRuntime.buildHttpLayer")(function* <
  App extends ApplicationIR,
  Routes extends RuntimeLayer,
>(
  application: App,
  options: ResolvedHttpOptions<Routes>,
) {

  const rpc = buildRpcLayer<App>(application, options.rpc)
  const mcp = buildMcpLayer<App>(application, options.mcp)
  const ui = yield* buildUiLayer<App, Routes>(application, options)
  const builtIn = Layer.mergeAll(rpc, mcp, ui)

  const routes = Option.match(options.routes, {
    onNone: Function.constant(builtIn),
    onSome: (routeLayer) => Layer.merge(builtIn, routeLayer),
  })

  // SAFETY: The layer retains its precise dependencies because Application.compile merged these exact handlers.
  const withHandlers = Layer.provideMerge(
    routes,
    application.handlers as Layer.Layer<Layer.Success<App["handlers"]>, Layer.Error<App["handlers"]>, Layer.Services<App["handlers"]>>,
  )

  const withAuthorization = Layer.provide(withHandlers, AuthorizationRpc.layer)
  const withSerialization = Layer.provide(withAuthorization, RpcSerialization.layerJson)

  return Layer.provide(withSerialization, FetchHttpClient.layer)
})

export const httpLayer = Effect.fn("ApplicationRuntime.httpLayer")(function* <
  App extends ApplicationIR,
  Routes extends RuntimeLayer = Layer.Layer<never>,
>(
  application: App,
  options: HttpOptions<Routes>,
) {
  const resolved = resolveHttpOptions<Routes>(options)

  return yield* buildHttpLayer<App, Routes>(application, resolved)
})

export const httpEffect = Effect.fn("ApplicationRuntime.httpEffect")(function* <
  App extends ApplicationIR,
  Database extends RuntimeLayer,
  Services extends RuntimeLayer = Layer.Layer<never>,
  Initialize extends Initialization = Effect.Effect<void>,
  Background extends RuntimeLayer = Layer.Layer<never>,
  Routes extends RuntimeLayer = Layer.Layer<never>,
>(
  application: App,
  database: Database & DatabaseLayer<Database>,
  options: ApplicationHttpOptions<Services, Initialize, Background, Routes>,
) {
  const runtimeContext = yield* buildContext<Database, Services, Initialize, Background>(application, database, options)
  const resolved = resolveHttpOptions<Routes>(options)
  const routes = yield* buildHttpLayer<App, Routes>(application, resolved)
  const runtimeLayer = Layer.succeedContext(runtimeContext)
  const providedRoutes = Layer.provide(routes, runtimeLayer)

  if (Option.isNone(resolved.telemetry)) {
    return yield* HttpRouter.toHttpEffect(providedRoutes)
  }

  const telemetryMiddleware = HttpRouter.middleware(
    ApplicationTelemetry.httpMiddleware,
    { global: true },
  )

  const applicationLayer = Layer.merge(providedRoutes, telemetryMiddleware)
  const handler = yield* HttpRouter.toHttpEffect(applicationLayer)
  const tracerDisabled = Layer.succeed(HttpMiddleware.TracerDisabledWhen, Function.constant(true))

  return Effect.provide(handler, tracerDisabled)
})

type RuntimeExecution<A, E, R, Database extends RuntimeLayer, Services extends RuntimeLayer, Initialize extends Initialization, Background extends RuntimeLayer> = Effect.Effect<
  A,
  E | MigrationError | Layer.Error<Database> | Layer.Error<Services> | Effect.Error<Initialize> | Layer.Error<Background>,
  | Scope.Scope
  | Layer.Services<Database>
  | Exclude<Layer.Services<Services>, SchemaStore | Layer.Success<Database>>
  | Exclude<Effect.Services<Initialize> | Layer.Services<Background>, SchemaStore | Layer.Success<Database> | Layer.Success<Services>>
  | Exclude<R, SchemaStore | Layer.Success<Database> | Layer.Success<Services> | Layer.Success<Background>>
>

export const use: <
  Database extends RuntimeLayer,
  Services extends RuntimeLayer = Layer.Layer<never>,
  Initialize extends Initialization = Effect.Effect<void>,
  Background extends RuntimeLayer = Layer.Layer<never>,
  A = unknown,
  E = never,
  R = never,
>(
  application: ApplicationIR,
  database: Database & DatabaseLayer<Database>,
  options: ApplicationRuntimeOptions<Services, Initialize, Background>,
  effect: Effect.Effect<A, E, R>,
) => RuntimeExecution<A, E, R, Database, Services, Initialize, Background> = Effect.fn("ApplicationRuntime.use")(function* <
  Database extends RuntimeLayer,
  Services extends RuntimeLayer = Layer.Layer<never>,
  Initialize extends Initialization = Effect.Effect<void>,
  Background extends RuntimeLayer = Layer.Layer<never>,
  A = unknown,
  E = never,
  R = never,
>(
  application: ApplicationIR,
  database: Database & DatabaseLayer<Database>,
  options: ApplicationRuntimeOptions<Services, Initialize, Background>,
  effect: Effect.Effect<A, E, R>,
) {
  const runtimeContext = yield* buildContext<Database, Services, Initialize, Background>(application, database, options)

  return yield* Effect.provideContext<A, E, R, SchemaStore | Layer.Success<Database> | Layer.Success<Services> | Layer.Success<Background>>(effect, runtimeContext)
})

