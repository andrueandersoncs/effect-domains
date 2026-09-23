import { Cause, Clock, Config, ConfigProvider, Duration, Effect, Equivalence, Exit, Function, Layer, Metric, Option, Predicate, Record, References, Schema, Struct, Tracer, pipe } from "effect"
import { HttpServerRequest, type HttpServerResponse } from "effect/unstable/http"
import * as HttpTraceContext from "effect/unstable/http/HttpTraceContext"
import { OtlpSerialization } from "effect/unstable/observability"
import { equalsProtocol, IngestPathSchema, PositiveFiniteSchema, PositiveIntegerSchema, ProtocolSchema, SampleRateSchema, type Signal, type TelemetryOptions, type TelemetryProtocol } from "./application-telemetry-config.ts"

const protocol = Effect.fn("ApplicationTelemetry.protocol")((
  signal: Signal,
  provider: ConfigProvider.ConfigProvider,
) => {
  const signalConfig = Config.schema(ProtocolSchema, `OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`)
  const optionalSignalConfig = Config.option(signalConfig)
  const selectConfig = Option.match({
    onNone: () => Config.schema(ProtocolSchema, "OTEL_EXPORTER_OTLP_PROTOCOL"),
    onSome: Effect.succeed,
  })
  const configured = Effect.flatMap(optionalSignalConfig, selectConfig)

  return Effect.provideService(configured, ConfigProvider.ConfigProvider, provider)
})

const serialization = (signal: Signal, provider: ConfigProvider.ConfigProvider) => {
  const configured = protocol(signal, provider)

  const selectLayer = (value: TelemetryProtocol) => equalsProtocol(value, "http/protobuf")
    ? OtlpSerialization.layerProtobuf
    : OtlpSerialization.layerJson

  const selected = Effect.map(configured, selectLayer)

  return Layer.unwrap(selected)
}

const noValidation = Function.constant(Effect.void)
const invalidDuration = Function.constant(Number.NaN)

const validateValue = Effect.fn("ApplicationTelemetry.validateValue")(<S extends Schema.Top>(
  schema: S,
  value: Option.Option<unknown>,
) => Option.match(value, {
  onNone: noValidation,
  onSome: (value) => pipe(
    Schema.decodeUnknownEffect(schema)(value),
    Effect.mapError((error) => new Config.ConfigError(error)),
    Effect.asVoid,
  ),
}))

const validateOptional = Effect.fn("ApplicationTelemetry.validateOptional")(<S extends Schema.Top>(
  schema: S,
  value: unknown,
) => {
  const optional = Option.fromNullishOr(value)

  return validateValue(schema, optional)
})

const validateDuration = Effect.fn("ApplicationTelemetry.validateDuration")((
  value: Option.Option<Duration.Input>,
) => Option.match(value, {
  onNone: noValidation,
  onSome: (duration) => pipe(
    Effect.try({
      try: () => Duration.toMillis(duration),
      catch: invalidDuration,
    }),
    Effect.flatMap((millis) => {
      const measured = Option.some(millis)

      return validateValue(PositiveFiniteSchema, measured)
    }),
  ),
}))

const validateOptions = Effect.fn("ApplicationTelemetry.validateOptions")(function* (options: TelemetryOptions) {
  const traces = Predicate.isObject(options.traces) ? options.traces : null
  const metrics = Predicate.isObject(options.metrics) ? options.metrics : null
  const logs = Predicate.isObject(options.logs) ? options.logs : null
  const browser = Predicate.isObject(options.browser) ? options.browser : null

  yield* validateOptional(Schema.URLFromString, options.endpoint)
  yield* validateOptional(Schema.URLFromString, traces?.endpoint)
  yield* validateOptional(Schema.URLFromString, metrics?.endpoint)
  yield* validateOptional(Schema.URLFromString, logs?.endpoint)
  yield* validateOptional(Schema.NonEmptyString, options.resource?.serviceName)
  yield* validateOptional(Schema.NonEmptyString, options.resource?.serviceVersion)
  yield* validateOptional(SampleRateSchema, traces?.sampleRate)
  yield* validateOptional(SampleRateSchema, browser?.sampleRate)
  yield* validateOptional(PositiveIntegerSchema, traces?.maxBatchSize)
  yield* validateOptional(PositiveIntegerSchema, logs?.maxBatchSize)
  yield* validateOptional(PositiveIntegerSchema, browser?.maxRequestBytes)
  yield* validateOptional(PositiveIntegerSchema, browser?.requestsPerMinute)
  yield* validateOptional(IngestPathSchema, browser?.ingestPath)

  for (const duration of [
    traces?.exportInterval,
    traces?.shutdownTimeout,
    metrics?.exportInterval,
    metrics?.shutdownTimeout,
    logs?.exportInterval,
    logs?.shutdownTimeout,
  ]) {
    yield* validateDuration(Option.fromNullishOr(duration))
  }
})

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

  if (disabled) return false

  const complete = rate >= 1

  if (complete) return true

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

    // SAFETY: The property belongs to the proxied Span because this trap only forwards accesses made through that Span.
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    const value = target[property as keyof Tracer.Span]

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

    const annotateStatus = Effect.fn("ApplicationTelemetry.annotateStatus")((
      response: HttpServerResponse.HttpServerResponse,
    ) => Effect.annotateCurrentSpan("http.response.status_code", response.status))

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
  serialization,
  validateOptions,
  withTelemetryTracer,
}
