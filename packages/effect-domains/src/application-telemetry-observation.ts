import { Cause, Clock, Effect, Equivalence, Exit, Function, Layer, Metric, Option, Predicate, Record, References, Struct, Tracer, pipe } from "effect"
import { HttpServerRequest, type HttpServerResponse } from "effect/unstable/http"
import * as HttpTraceContext from "effect/unstable/http/HttpTraceContext"

// SAFETY: The target intersects the source rather than discarding it because callers retain all source evidence and state each narrowing invariant.
const narrowContract = <Target, Source>(value: Source) => value as Source & Target

const durationBoundaries = Metric.boundariesFromIterable([
  0.005,
  0.01,
  0.025,
  0.05,
  0.075,
  0.1,
  0.25,
  0.5,
  0.75,
  1,
  2.5,
  5,
  7.5,
  10,
])

const httpServerDuration = Metric.histogram("http.server.request.duration", {
  boundaries: durationBoundaries,
  description: "Duration of inbound HTTP requests",
  attributes: { unit: "s" },
})

const rpcServerDuration = Metric.histogram("rpc.server.call.duration", {
  boundaries: durationBoundaries,
  description: "Duration of inbound Effect RPC calls",
  attributes: { unit: "s" },
})

const sampledByValue = (rate: number, value: number) => value < rate

const randomSample = (rate: number, crypto: Pick<Crypto, "getRandomValues">) => {
  const disabled = rate <= 0
  const complete = rate >= 1
  const boundaryRate = disabled || complete

  if (boundaryRate) return complete

  const value = new Uint32Array(1)

  crypto.getRandomValues(value)

  const normalized = (value[0] ?? 0) / 0x1_0000_0000

  return sampledByValue(rate, normalized)
}

const taggedFailure = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return Option.none<string>()

  const failure = Cause.findErrorOption(exit.cause)

  if (Option.isNone(failure)) {
    const type = Cause.hasInterruptsOnly(exit.cause) ? "interrupt" : "defect"

    return Option.some(type)
  }

  if (!Predicate.hasProperty(failure.value, "_tag")) return Option.some("error")

  return Predicate.isString(failure.value._tag)
    ? Option.some(failure.value._tag)
    : Option.some("error")
}

const observeRpcSpan = (
  span: Tracer.Span,
  startTime: bigint,
  exit: Exit.Exit<unknown, unknown>,
) => {
  const method = span.name.slice("RpcServer.".length)

  const baseAttributes = pipe(
    Record.empty<string, string>(),
    (attributes) => Record.set(attributes, "rpc.method", method),
    (attributes) => Record.set(attributes, "rpc.system.name", "effect"),
  )

  const attributes = pipe(
    taggedFailure(exit),
    Option.match({
      onNone: Function.constant(baseAttributes),
      onSome: (type) => Record.set(baseAttributes, "error.type", type),
    }),
  )

  const ended = Predicate.isTagged(span.status, "Ended")
  const duration = ended ? span.status.endTime - startTime : 0n
  const seconds = Number(duration) / 1_000_000_000
  const observed = Metric.withAttributes(rpcServerDuration, attributes)
  const update = Metric.update(observed, seconds)

  Effect.runSync(update)

  return seconds
}


const observedSpan = (
  span: Tracer.Span,
  startTime: bigint,
) => {
  const get: NonNullable<ProxyHandler<Tracer.Span>["get"]> = (target, property) => {
    const endProperty = Equivalence.strictEqual<PropertyKey>()(property, "end")

    if (endProperty) {
      const endSpan = (endTime: bigint, exit: Exit.Exit<unknown, unknown>) => {
        target.end(endTime, exit)

        return observeRpcSpan(target, startTime, exit)
      }

      return endSpan
    }

    const spanProperty = narrowContract<keyof Tracer.Span, typeof property>(property)
    const value = target[spanProperty]

    return Predicate.isFunction(value) ? value.bind(target) : value
  }

  const handler: ProxyHandler<Tracer.Span> = { get }

  return new Proxy(span, handler)
}

const withTelemetryTracer = <ROut, E, RIn>(
  tracerLayer: Layer.Layer<ROut, E, RIn>,
  sampleRate: Option.Option<number>,
  observeRpc: boolean,
  crypto: Pick<Crypto, "getRandomValues">,
) => {
  const completeSampling = Option.match(sampleRate, {
    onNone: Function.constant(true),
    onSome: (rate) => rate >= 1,
  })

  const samplingConfigured = !completeSampling
  const traceEverything = !samplingConfigured
  const noRpcObservation = !observeRpc
  const unnecessary = traceEverything && noRpcObservation

  if (unnecessary) return tracerLayer

  const makeTelemetryTracer = (tracer: Tracer.Tracer): Tracer.Tracer => {
    const wrapSpan = (delegate: Tracer.Tracer["span"]) => {
      const createSpan = (spanOptions: Parameters<Tracer.Tracer["span"]>[0]) => {
        const inherited = Option.isSome(spanOptions.parent)

        const sampleRoot = Option.match(sampleRate, {
          onNone: Function.constant(true),
          onSome: (rate) => randomSample(rate, crypto),
        })

        const sampledRoot = spanOptions.sampled && sampleRoot
        const sampled = inherited ? spanOptions.sampled : sampledRoot
        const configured = Struct.evolve(spanOptions, { sampled: Function.constant(sampled) })
        const span = delegate.call(tracer, configured)
        const serverRpc = span.name.startsWith("RpcServer.")
        const shouldObserve = observeRpc && serverRpc

        return shouldObserve ? observedSpan(span, spanOptions.startTime) : span
      }

      return createSpan
    }

    return Struct.evolve(tracer, { span: wrapSpan })
  }

  const telemetryTracer = pipe(Effect.tracer, Effect.map(makeTelemetryTracer))
  const telemetryTracerLayer = Layer.effect(Tracer.Tracer, telemetryTracer)

  return pipe(telemetryTracerLayer, Layer.provideMerge(tracerLayer))
}

const httpMiddleware = Effect.fn("ApplicationTelemetry.httpMiddleware")(function* <E, R>(
  httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest>,
) {
    const request = yield* HttpServerRequest.HttpServerRequest
    const start = yield* Clock.currentTimeNanos
    const forwardedProtocol = request.headers["x-forwarded-proto"] ?? ""
    const forwardedHttps = Equivalence.strictEqual<string>()(forwardedProtocol, "https")
    const scheme = forwardedHttps ? "https" : "http"
    const { method } = request

    const annotateStatus = Effect.fn("ApplicationTelemetry.annotateStatus")(function* (
      response: HttpServerResponse.HttpServerResponse,
    ) {
      yield* Effect.annotateCurrentSpan("http.response.status_code", response.status)
    })

    const traceContext = HttpTraceContext.fromHeaders(request.headers)
    const parent = Option.getOrUndefined(traceContext)

    const observed = pipe(
      httpApp,
      Effect.tap(annotateStatus),
      Effect.withSpan(`http.server ${method}`, {
        parent,
        kind: "server",
        attributes: {
          "http.request.method": method,
          "url.scheme": scheme,
        },
      }),
    )

    const exit = yield* Effect.exit(observed)
    const end = yield* Clock.currentTimeNanos
    const status = Exit.isSuccess(exit) ? exit.value.status : 500
    const statusCode = String(status)

    const baseAttributes = pipe(
      Record.empty<string, string>(),
      (attributes) => Record.set(attributes, "http.request.method", method),
      (attributes) => Record.set(attributes, "http.response.status_code", statusCode),
      (attributes) => Record.set(attributes, "url.scheme", scheme),
    )

    const failed = status >= 400
    const errorType = `http_${Math.floor(status / 100)}xx`

    const attributes = failed
      ? Record.set(baseAttributes, "error.type", errorType)
      : baseAttributes

    const metric = Metric.withAttributes(httpServerDuration, attributes)
    const seconds = Number(end - start) / 1_000_000_000

    yield* Metric.update(metric, seconds)

    return yield* exit
})

export {
  httpMiddleware,
  withTelemetryTracer,
}
