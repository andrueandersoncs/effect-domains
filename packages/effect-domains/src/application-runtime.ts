import { Array, Context, Data, Effect, Function, Layer, Option, Predicate, Record, Schema, pipe } from "effect"
import { FetchHttpClient, HttpMiddleware, HttpRouter } from "effect/unstable/http"
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { Application, type ApplicationIR } from "./application.ts"
import { ApplicationUi, type ApplicationUiAssets, type ApplicationUiOptions } from "./application-ui.ts"
import { ApplicationTelemetry } from "./application-telemetry.ts"
import type { TelemetryOptions } from "./application-telemetry-config.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
import { RpcMcp } from "./rpc-mcp.ts"
import { SchemaStore } from "./migrations.ts"

export type RuntimeLayer = Layer.Any

type RuntimeLayerValue<Runtime extends RuntimeLayer> = Layer.Layer<
  Layer.Success<Runtime>,
  Layer.Error<Runtime>,
  Layer.Services<Runtime>
>

type DatabaseLayer<E, R> = Layer.Layer<SchemaStore, E, R>
export type Initialization = Effect.Effect<void, any, any>

export type ApplicationRuntimeOptions<
  Services extends RuntimeLayer = Layer.Layer<never, never, never>,
  Initialize extends Initialization = Effect.Effect<void>,
  Background extends RuntimeLayer = Layer.Layer<never, never, never>,
> = Readonly<Partial<{
  services: RuntimeLayerValue<Services>
  initialize: Initialize
  background: RuntimeLayerValue<Background>
}>>

type HttpEndpointOptions = Readonly<{ path: `/${string}` }>
type RoutesHttpOptions<Routes extends RuntimeLayer> = Readonly<Partial<{ routes: RuntimeLayerValue<Routes> }>>

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

class ApplicationUiAssetsUnavailable extends Schema.TaggedError<ApplicationUiAssetsUnavailable>()(
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
) => {
  const defaultEndpoint = Option.some(defaultPath)

  return Option.match(setting, {
    onNone: Function.constant(defaultEndpoint),
    onSome: (value) => Predicate.isBoolean(value) ? Option.none() : Option.some(value.path),
  })
}

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

  return new ResolvedHttpOptions({ routes, rpc, mcp, ui, uiAssets, telemetry })
}

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

  const services = Predicate.isUndefined(options.services)
    ? Context.empty()
    : yield* pipe(
      Layer.build<Layer.Services<Services>, Layer.Error<Services>, Layer.Success<Services>>(options.services),
      Effect.provideContext(databaseContext),
    )

  const serviceContext = Context.merge(databaseContext, services)

  if (!Predicate.isUndefined(options.initialize)) {
    yield* Effect.provideContext(options.initialize, serviceContext)
  }

  const background = Predicate.isUndefined(options.background)
    ? Context.empty()
    : yield* pipe(
      Layer.build<Layer.Services<Background>, Layer.Error<Background>, Layer.Success<Background>>(options.background),
      Effect.provideContext(serviceContext),
    )

  return Context.merge(serviceContext, background)
})

const buildUiLayer = Effect.fn("ApplicationRuntime.uiLayer")(function* <
  Routes extends RuntimeLayer,
>(
  application: ApplicationIR,
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

const buildRpcLayer = (
  application: ApplicationIR,
  rpc: Option.Option<`/${string}`>,
) => Option.match(rpc, {
  onNone: Function.constant(Layer.empty),
  onSome: (path) => {
    const procedures = pipe(application.group.requests.values(), Array.fromIterable)
    const rpcs = Array.filter(procedures, Rpc.isRpc)
    const group = RpcGroup.make(...rpcs)

    return RpcServer.layerHttp({ group, path, protocol: "http" })
  },
})

const buildMcpLayer = (
  application: ApplicationIR,
  mcp: Option.Option<`/${string}`>,
) => Option.match(mcp, {
  onNone: Function.constant(Layer.empty),
  onSome: (path) => RpcMcp.layerHttp({ application, path }),
})

const buildHttpLayer = Effect.fn("ApplicationRuntime.buildHttpLayer")(function* <
  Routes extends RuntimeLayer,
>(
  application: ApplicationIR,
  options: ResolvedHttpOptions<Routes>,
) {

  const rpc = buildRpcLayer(application, options.rpc)
  const mcp = buildMcpLayer(application, options.mcp)
  const ui = yield* buildUiLayer(application, options)
  const builtIn = Layer.mergeAll(rpc, mcp, ui)

  const routes = Option.match(options.routes, {
    onNone: Function.constant(builtIn),
    onSome: (routeLayer) => Layer.merge(builtIn, routeLayer),
  })

  const withHandlers = Layer.provideMerge(routes, application.handlers)
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

