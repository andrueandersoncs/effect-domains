import { Context, Effect, Equivalence, Function, Layer, Option, Predicate, Schema, pipe } from "effect"
import { FetchHttpClient, HttpMiddleware, HttpRouter } from "effect/unstable/http"
import { type Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { Application, type ApplicationIR } from "./application.ts"
import { ApplicationUi, type ApplicationUiOptions } from "./application-ui.ts"
import { ApplicationTelemetry, type TelemetryOptions } from "./application-telemetry.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
import { RpcMcp } from "./rpc-mcp.ts"

export type RuntimeLayer = Layer.Layer<never, any, any>
export type Initialization = Effect.Effect<any, any, any>

export type ApplicationRuntimeOptions<
  Services extends RuntimeLayer = Layer.Layer<never, never, never>,
  Initialize extends Initialization = Effect.Effect<void>,
  Background extends RuntimeLayer = Layer.Layer<never, never, never>,
> = Readonly<Partial<{
  services: Services
  initialize: Initialize
  background: Background
}>>

export type ApplicationHttpOptions<
  Services extends RuntimeLayer = Layer.Layer<never, never, never>,
  Initialize extends Initialization = Effect.Effect<void>,
  Background extends RuntimeLayer = Layer.Layer<never, never, never>,
  Routes extends RuntimeLayer = Layer.Layer<never, never, never>,
> = ApplicationRuntimeOptions<Services, Initialize, Background> & Readonly<Partial<{
  routes: Routes
  rpc: false | Readonly<{ path: `/${string}` }>
  mcp: false | Readonly<{ path: `/${string}` }>
  ui: false | true | ApplicationUiOptions
  uiAssets: Readonly<{ javascript: string; stylesheet: string }>
  telemetry: false | TelemetryOptions
}>>


class ApplicationUiAssetsUnavailable extends Schema.TaggedError<ApplicationUiAssetsUnavailable>()(
  "ApplicationUiAssetsUnavailable",
  {},
) {
  override get message() {
    return "Application UI assets are required when the generated UI is enabled"
  }
}

type AnyApplicationHttpOptions = ApplicationHttpOptions<
  RuntimeLayer,
  Initialization,
  RuntimeLayer,
  RuntimeLayer
>

const same = Equivalence.strictEqual<unknown>()
const disabledBoolean = (value: unknown) => same(value, false)

const buildContext = Effect.fn("ApplicationRuntime.buildContext")(function* <
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Background extends RuntimeLayer,
>(
  application: ApplicationIR,
  database: RuntimeLayer,
  options: ApplicationRuntimeOptions<Services, Initialize, Background>,
) {
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

  return Context.merge(serviceContext, background)
})

const uiLayer = Effect.fn("ApplicationRuntime.uiLayer")(function* (
  application: ApplicationIR,
  options: AnyApplicationHttpOptions,
) {
  const configured = Option.fromNullishOr(options.ui)

  return yield* Option.match(configured, {
    onNone: () => Effect.succeed(Layer.empty),
    onSome: Effect.fn("ApplicationRuntime.configuredUi")(function* (configuration) {

      if (disabledBoolean(configuration)) return Layer.empty

      const assets = yield* pipe(
        Option.fromNullishOr(options.uiAssets),
        Effect.fromOption,
        Effect.mapError(() => ApplicationUiAssetsUnavailable.make({})),
      )

      const presentation = Predicate.isBoolean(configuration) ? {} : configuration
      const telemetry = Predicate.isBoolean(options.telemetry) ? undefined : options.telemetry

      return ApplicationUi.layerHttp({
        application,
        ...assets,
        ...presentation,
        telemetry,
      })
    }),
  })
})

export const httpLayer = Effect.fn("ApplicationRuntime.httpLayer")(function* (
  application: ApplicationIR,
  options: AnyApplicationHttpOptions,
) {
  const rpcPath = Predicate.isBoolean(options.rpc) ? "/rpc/v1" : options.rpc?.path ?? "/rpc/v1"
  const mcpPath = Predicate.isBoolean(options.mcp) ? "/mcp" : options.mcp?.path ?? "/mcp"
  const rpcDisabled = disabledBoolean(options.rpc)
  const mcpDisabled = disabledBoolean(options.mcp)

  const rpc = rpcDisabled
    ? Layer.empty
    : RpcServer.layerHttp({
      group: application.group as RpcGroup.RpcGroup<Rpc.AnyWithProps>,
      path: rpcPath,
      protocol: "http",
    })

  const mcp = mcpDisabled ? Layer.empty : RpcMcp.layerHttp({ application, path: mcpPath })
  const ui = yield* uiLayer(application, options)

  return pipe(
    Layer.mergeAll(rpc, mcp, ui, options.routes ?? Layer.empty),
    Layer.provideMerge(application.handlers),
    Layer.provide(AuthorizationRpc.layer),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
  )
})

export const httpEffect = Effect.fn("ApplicationRuntime.httpEffect")(function* <
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Background extends RuntimeLayer,
  Routes extends RuntimeLayer,
>(
  application: ApplicationIR,
  database: RuntimeLayer,
  options: ApplicationHttpOptions<Services, Initialize, Background, Routes>,
) {
  const runtimeContext = yield* buildContext(application, database, options)
  const routes = yield* httpLayer(application, options)
  const runtimeLayer = Layer.succeedContext(runtimeContext)
  const providedRoutes = Layer.provide(routes, runtimeLayer)
  const telemetryDisabled = Predicate.isBoolean(options.telemetry)
  const telemetryMiddleware = HttpRouter.middleware(ApplicationTelemetry.httpMiddleware, { global: true })

  const applicationLayer = telemetryDisabled
    ? providedRoutes
    : Layer.merge(providedRoutes, telemetryMiddleware)

  const handler = yield* HttpRouter.toHttpEffect(applicationLayer)
  const tracerDisabled = Layer.succeed(HttpMiddleware.TracerDisabledWhen, Function.constant(true))

  return telemetryDisabled ? handler : pipe(handler, Effect.provide(tracerDisabled))
})

export const use = Effect.fn("ApplicationRuntime.use")(function* <
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Background extends RuntimeLayer,
  A,
  E,
  R,
>(
  application: ApplicationIR,
  database: RuntimeLayer,
  options: ApplicationRuntimeOptions<Services, Initialize, Background>,
  effect: Effect.Effect<A, E, R>,
) {
  const runtimeContext = yield* buildContext(application, database, options)
  return yield* Effect.provideContext(effect, runtimeContext)
})

