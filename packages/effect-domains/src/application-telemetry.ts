import {
  Array,
  Cause,
  Clock,
  Config,
  ConfigProvider,
  Duration,
  Effect,
  Equivalence,
  Exit,
  Function,
  HashMap,
  Layer,
  Match,
  Metric,
  Option,
  Predicate,
  Record,
  Ref,
  Result,
  References,
  Schema,
  Struct,
  Tracer,
  flow,
  pipe,
} from "effect"

import type { LogLevel } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpTraceContext from "effect/unstable/http/HttpTraceContext"

import {
  OtlpLogger,
  OtlpMetrics,
  OtlpSerialization,
  OtlpTracer,
} from "effect/unstable/observability"

import type { ApplicationIR } from "./application.ts"

type TelemetryProtocol = "http/protobuf" | "http/json"
type TelemetryResource = NonNullable<Parameters<typeof OtlpTracer.layer>[0]["resource"]>

type SignalOptions = Readonly<Partial<{
  endpoint: string
  protocol: TelemetryProtocol
  headers: Headers.Input
  exportInterval: Duration.Input
  shutdownTimeout: Duration.Input
}>>

type TraceOptions = SignalOptions & Readonly<Partial<{
  maxBatchSize: number
  sampleRate: number
  minimumLevel: LogLevel.LogLevel
}>>

type MetricOptions = SignalOptions & Readonly<Partial<{
  temporality: OtlpMetrics.AggregationTemporality
}>>

type LogOptions = SignalOptions & Readonly<Partial<{
  maxBatchSize: number
  minimumLevel: LogLevel.LogLevel
  excludeLogSpans: boolean
  mergeWithExisting: boolean
}>>


export type TelemetryOptions = Readonly<Partial<{
  /** OTLP base URL. `/v1/traces`, `/v1/metrics`, and `/v1/logs` are appended. */
  endpoint: string
  protocol: TelemetryProtocol
  resource: TelemetryResource
  headers: Headers.Input
  traces: false | TraceOptions
  metrics: false | MetricOptions
  logs: false | LogOptions
  browser: false | Readonly<Partial<{
    ingestPath: `/${string}`
    sampleRate: number
    signals: Readonly<Partial<{
      traces: boolean
      metrics: boolean
      logs: boolean
    }>>
    maxRequestBytes: number
    requestsPerMinute: number
  }>>
}>>

type BrowserOptions = Exclude<NonNullable<TelemetryOptions["browser"]>, false>

const BrowserTelemetrySignalsSchema = Schema.Struct({
  traces: Schema.Boolean,
  metrics: Schema.Boolean,
  logs: Schema.Boolean,
})

const BrowserTelemetryEndpointSchema = Schema.TemplateLiteral(["/", Schema.String])
const OptionalBrowserSampleRateSchema = Schema.optionalKey(Schema.Number)

class BrowserTelemetryConfiguration extends Schema.Class<BrowserTelemetryConfiguration>("BrowserTelemetryConfiguration")({
  endpoint: BrowserTelemetryEndpointSchema,
  serviceName: Schema.String,
  sampleRate: OptionalBrowserSampleRateSchema,
  signals: BrowserTelemetrySignalsSchema,
}) {}

const PositiveFiniteSchema = Schema.Finite.check(Schema.isGreaterThan(0))
const PositiveIntegerSchema = Schema.Int.check(Schema.isGreaterThan(0))
const IngestPathSchema = Schema.String.check(Schema.isPattern(/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/))
const ProtocolSchema = Schema.Literals(["http/protobuf", "http/json"])
const SampleRateSchema = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

type Signal = "TRACES" | "METRICS" | "LOGS"
type SignalName = Lowercase<Signal>

const UrlSchema = Schema.instanceOf(URL)

class OtlpTransport extends Schema.Class<OtlpTransport>("OtlpTransport")({
  endpoint: UrlSchema,
  headers: Headers.HeadersSchema,
}) {}

const equalsProtocol = Equivalence.strictEqual<TelemetryProtocol>()
const equalsFalse = Equivalence.strictEqual<unknown>()
const ExportersSchema = Config.Array(Schema.String)
const HeadersRecordSchema = Config.Record(Schema.String, Schema.StringFromUriComponent)
const normalizeExporter = (value: string) => value.trim().toLowerCase()

const milliseconds = (duration: Option.Option<Duration.Input>) => pipe(
  duration,
  Option.map(flow(Duration.toMillis, String)),
  Option.getOrUndefined,
)

const signalEndpoint = (base: string, signal: Signal) => {
  const url = new URL(base)
  const trailingSlash = url.pathname.endsWith("/")
  const separator = trailingSlash ? "" : "/"
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const name = signal.toLowerCase() as SignalName

  url.pathname += `${separator}v1/${name}`

  return url.href
}


const environment = (options: TelemetryOptions) => {
  const traces = Predicate.isObject(options.traces) ? options.traces : null
  const metrics = Predicate.isObject(options.metrics) ? options.metrics : null
  const logs = Predicate.isObject(options.logs) ? options.logs : null
  const baseEndpoint = Option.fromUndefinedOr(options.endpoint)

  const endpointFor = (signal: Signal) =>
    pipe(baseEndpoint, Option.map((base) => signalEndpoint(base, signal)), Option.getOrUndefined)

  const tracesEndpoint = endpointFor("TRACES")
  const metricsEndpoint = endpointFor("METRICS")
  const logsEndpoint = endpointFor("LOGS")
  const tracesDisabled = equalsFalse(options.traces, false)
  const metricsDisabled = equalsFalse(options.metrics, false)
  const logsDisabled = equalsFalse(options.logs, false)
  const traceExportIntervalOption = Option.fromUndefinedOr(traces?.exportInterval)
  const traceExportInterval = milliseconds(traceExportIntervalOption)
  const traceBatchSize = pipe(Option.fromNullishOr(traces?.maxBatchSize), Option.map(String), Option.getOrUndefined)
  const traceShutdownTimeoutOption = Option.fromUndefinedOr(traces?.shutdownTimeout)
  const traceShutdownTimeout = milliseconds(traceShutdownTimeoutOption)
  const metricExportIntervalOption = Option.fromUndefinedOr(metrics?.exportInterval)
  const metricExportInterval = milliseconds(metricExportIntervalOption)
  const metricShutdownTimeoutOption = Option.fromUndefinedOr(metrics?.shutdownTimeout)
  const metricShutdownTimeout = milliseconds(metricShutdownTimeoutOption)
  const logExportIntervalOption = Option.fromUndefinedOr(logs?.exportInterval)
  const logExportInterval = milliseconds(logExportIntervalOption)
  const logBatchSize = pipe(Option.fromNullishOr(logs?.maxBatchSize), Option.map(String), Option.getOrUndefined)
  const logShutdownTimeoutOption = Option.fromUndefinedOr(logs?.shutdownTimeout)
  const logShutdownTimeout = milliseconds(logShutdownTimeoutOption)

  return Record.fromEntries([
    ["OTEL_SERVICE_NAME", options.resource?.serviceName],
    ["OTEL_EXPORTER_OTLP_ENDPOINT", options.endpoint],
    ["OTEL_EXPORTER_OTLP_PROTOCOL", options.protocol],
    ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", traces?.endpoint ?? tracesEndpoint],
    ["OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", traces?.protocol],
    ["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", metrics?.endpoint ?? metricsEndpoint],
    ["OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", metrics?.protocol],
    ["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", logs?.endpoint ?? logsEndpoint],
    ["OTEL_EXPORTER_OTLP_LOGS_PROTOCOL", logs?.protocol],
    ["OTEL_TRACES_EXPORTER", tracesDisabled ? "none" : undefined],
    ["OTEL_METRICS_EXPORTER", metricsDisabled ? "none" : undefined],
    ["OTEL_LOGS_EXPORTER", logsDisabled ? "none" : undefined],
    ["OTEL_BSP_SCHEDULE_DELAY", traceExportInterval],
    ["OTEL_BSP_MAX_EXPORT_BATCH_SIZE", traceBatchSize],
    ["OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", traceShutdownTimeout],
    ["OTEL_METRIC_EXPORT_INTERVAL", metricExportInterval],
    ["OTEL_METRIC_EXPORT_TIMEOUT", metricShutdownTimeout],
    ["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE", metrics?.temporality],
    ["OTEL_BLRP_SCHEDULE_DELAY", logExportInterval],
    ["OTEL_BLRP_MAX_EXPORT_BATCH_SIZE", logBatchSize],
    ["OTEL_EXPORTER_OTLP_LOGS_TIMEOUT", logShutdownTimeout],
  ])
}

const signalTransport = Effect.fn("ApplicationTelemetry.signalTransport")(function* (
  signal: Signal,
  options: TelemetryOptions,
) {
  const current = yield* ConfigProvider.ConfigProvider
  const overrideValues = environment(options)
  const overrides = ConfigProvider.fromEnvRecord(overrideValues)
  const provider = ConfigProvider.orElse(overrides, current)
  const exporterConfig = Config.schema(ExportersSchema, `OTEL_${signal}_EXPORTER`)

  const exporters = yield* pipe(
    exporterConfig,
    Config.withDefault<ReadonlyArray<string>>(["otlp"]),
    Effect.provideService(ConfigProvider.ConfigProvider, provider),
  )

  const normalizedExporters = Array.map(exporters, normalizeExporter)
  const enabled = Array.contains(normalizedExporters, "otlp")

  if (!enabled) return Option.none<OtlpTransport>()

  const genericEndpoint = pipe(
    Config.url("OTEL_EXPORTER_OTLP_ENDPOINT"),
    Config.map((url) => {
      const endpoint = signalEndpoint(url.href, signal)

      return new URL(endpoint)
    }),
  )

  const endpoint = yield* pipe(
    Config.url(`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`),
    Config.orElse(Function.constant(genericEndpoint)),
    Config.option,
    Effect.provideService(ConfigProvider.ConfigProvider, provider),
  )

  const genericHeaders = Config.schema(HeadersRecordSchema, "OTEL_EXPORTER_OTLP_HEADERS")

  const configuredHeaders = yield* pipe(
    Config.schema(HeadersRecordSchema, `OTEL_EXPORTER_OTLP_${signal}_HEADERS`),
    Config.orElse(Function.constant(genericHeaders)),
    Config.withDefault<Record<string, string>>({}),
    Effect.provideService(ConfigProvider.ConfigProvider, provider),
  )

  const signalOptions = pipe(
    Match.value(signal),
    Match.when("TRACES", Function.constant(options.traces)),
    Match.when("METRICS", Function.constant(options.metrics)),
    Match.when("LOGS", Function.constant(options.logs)),
    Match.exhaustive,
  )

  const explicitHeaders = Predicate.isObject(signalOptions) ? signalOptions.headers : options.headers
  const environmentHeaders = Headers.fromInput(configuredHeaders)
  const optionHeaders = Headers.fromInput(explicitHeaders)
  const headers = Headers.merge(environmentHeaders, optionHeaders)
  const makeTransport = (url: URL) => OtlpTransport.make({ endpoint: url, headers })

  return Option.map(endpoint, makeTransport)
})


class GatewayWindow extends Schema.Class<GatewayWindow>("GatewayWindow")({
  startedAt: Schema.Number,
  count: Schema.Int,
}) {}

const browserGateway = Effect.fn("ApplicationTelemetry.browserGateway")(function* (
  options: Readonly<{ application: ApplicationIR }> & Readonly<Partial<{
    telemetry: TelemetryOptions | null
    allowedOrigins: ReadonlyArray<string>
  }>>,
) {
  const telemetryOption = Option.fromNullishOr(options.telemetry)

  if (Option.isNone(telemetryOption)) return Option.none<BrowserTelemetryConfiguration>()

  const { value: telemetry } = telemetryOption

  const configuredBrowser = pipe(
    Option.fromUndefinedOr(telemetry.browser),
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    Option.filter(Predicate.isObject as Predicate.Refinement<unknown, BrowserOptions>),
  )

  const emptyBrowser: BrowserOptions = Record.empty()
  const browser = pipe(configuredBrowser, Option.getOrElse(Function.constant(emptyBrowser)))
  const ingestPath = browser.ingestPath ?? "/otel"
  const emptySignals: NonNullable<BrowserOptions["signals"]> = Record.empty()
  const configuredSignals = browser.signals ?? emptySignals
  const tracesRequested = !equalsFalse(configuredSignals.traces, false)
  const tracesExported = !equalsFalse(telemetry.traces, false)
  const tracesEnabled = tracesRequested && tracesExported
  const metricsRequested = !equalsFalse(configuredSignals.metrics, false)
  const metricsExported = !equalsFalse(telemetry.metrics, false)
  const metricsEnabled = metricsRequested && metricsExported
  const logsRequested = !equalsFalse(configuredSignals.logs, false)
  const logsExported = !equalsFalse(telemetry.logs, false)
  const logsEnabled = logsRequested && logsExported
  const noTransport = Option.none<OtlpTransport>()
  const tracesTransport = tracesEnabled ? yield* signalTransport("TRACES", telemetry) : noTransport
  const metricsTransport = metricsEnabled ? yield* signalTransport("METRICS", telemetry) : noTransport
  const logsTransport = logsEnabled ? yield* signalTransport("LOGS", telemetry) : noTransport

  const signals = BrowserTelemetrySignalsSchema.make({
    traces: Option.isSome(tracesTransport),
    metrics: Option.isSome(metricsTransport),
    logs: Option.isSome(logsTransport),
  })

  const anySignal = Array.some([signals.traces, signals.metrics, signals.logs], Boolean)

  if (!anySignal) return Option.none<BrowserTelemetryConfiguration>()

  const router = yield* HttpRouter.HttpRouter
  const client = yield* HttpClient.HttpClient
  const maxRequestBytes = browser.maxRequestBytes ?? 256 * 1024
  const requestsPerMinute = browser.requestsPerMinute ?? 120
  const emptyWindows = HashMap.empty<string, GatewayWindow>()
  const windows = yield* Ref.make(emptyWindows)
  const noStore = Headers.set(Headers.empty, "cache-control", "no-store")
  const reject = (status: number) => HttpServerResponse.empty({ status, headers: noStore })

  const isTrusted = (request: HttpServerRequest.HttpServerRequest) => {
    const fetchSite = request.headers["sec-fetch-site"] ?? ""
    const crossSite = Equivalence.strictEqual<string>()(fetchSite, "cross-site")
    const siteTrusted = !crossSite
    const origin = Option.fromUndefinedOr(request.headers.origin)

    const originTrusted = Option.match(origin, {
      onNone: Function.constant(true),
      onSome: (origin) => {
        const url = HttpServerRequest.toURL(request)

        return Option.match(url, {
          onNone: Function.constant(false),
          onSome: (url) => {
            const sameOrigin = Equivalence.strictEqual<string>()(origin, url.origin)
            const allowedOrigins = Option.fromUndefinedOr(options.allowedOrigins)
            const explicitlyAllowed = Option.exists(allowedOrigins, (allowed) => Array.contains(allowed, origin))

            return sameOrigin || explicitlyAllowed
          },
        })
      },
    })

    return siteTrusted && originTrusted
  }

  const rateLimited = Effect.fn("ApplicationTelemetry.browserGatewayRateLimit")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const now = Date.now()
    const cutoff = now - 60_000
    const address = Option.getOrElse(request.remoteAddress, Function.constant("unknown"))

    return yield* Ref.modify(windows, (currentWindows) => {
      const oversized = HashMap.size(currentWindows) > 1_024

      const activeWindows = oversized
        ? HashMap.filter(currentWindows, (window) => window.startedAt >= cutoff)
        : currentWindows

      const saturated = HashMap.size(activeWindows) >= 1_024
      const unknownAddress = !HashMap.has(activeWindows, address)
      const overflow = saturated && unknownAddress
      const key = overflow ? "overflow" : address
      const current = HashMap.get(activeWindows, key)

      return Option.match(current, {
        onNone: () => {
          const window = GatewayWindow.make({ startedAt: now, count: 1 })
          const nextWindows = HashMap.set(activeWindows, key, window)

          return [false, nextWindows] as const
        },
        onSome: (window) => {
          const fresh = window.startedAt >= cutoff
          const count = fresh ? window.count + 1 : 1
          const startedAt = fresh ? window.startedAt : now
          const next = GatewayWindow.make({ startedAt, count })
          const nextWindows = HashMap.set(activeWindows, key, next)

          return [count > requestsPerMinute, nextWindows] as const
        },
      })
    })
  })

  const addRoute = Effect.fn("ApplicationTelemetry.browserGatewayRoute")(function* (
    signal: SignalName,
    transport: Option.Option<OtlpTransport>,
  ) {
    if (Option.isNone(transport)) return

    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    const path = `${ingestPath}/v1/${signal}` as `/${string}`

    const handler = Effect.fn("ApplicationTelemetry.browserGateway.forward")(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      if (!isTrusted(request)) return reject(403)

      const limited = yield* rateLimited(request)

      if (limited) return reject(429)

      const normalizeHeader = (value: string) => value.trim().toLowerCase()

      const contentEncoding = pipe(
        Option.fromUndefinedOr(request.headers["content-encoding"]),
        Option.map(normalizeHeader),
      )

      const identityEncoding = Equivalence.strictEqual<string>()
      const isCompressed = (value: string) => !identityEncoding(value, "identity")
      const compressed = Option.exists(contentEncoding, isCompressed)

      if (compressed) return reject(415)

      const normalizeContentType = (value: string) => {
        const parts = value.split(";", 1)
        const mediaType = pipe(Array.head(parts), Option.getOrElse(Function.constant("")))

        return normalizeHeader(mediaType)
      }

      const contentType = pipe(
        Option.fromUndefinedOr(request.headers["content-type"]),
        Option.map(normalizeContentType),
        Option.getOrElse(Function.constant("")),
      )

      const protobuf = Equivalence.strictEqual<string>()(contentType, "application/x-protobuf")
      const json = Equivalence.strictEqual<string>()(contentType, "application/json")
      const supported = protobuf || json

      if (!supported) return reject(415)

      const contentLength = Number(request.headers["content-length"] ?? 0)
      const declaredOversized = Number.isFinite(contentLength) && contentLength > maxRequestBytes

      if (declaredOversized) return reject(413)

      const body = yield* Effect.result(request.arrayBuffer)

      if (Result.isFailure(body)) return reject(400)
      if (body.success.byteLength > maxRequestBytes) return reject(413)

      const requestBytes = new Uint8Array(body.success)
      const requestWithBody = HttpClientRequest.bodyUint8Array(requestBytes, contentType)

      const outbound = pipe(
        HttpClientRequest.post(transport.value.endpoint),
        HttpClientRequest.setHeaders(transport.value.headers),
        requestWithBody,
      )

      const forwarding = client.execute(outbound)
      const forwarded = yield* Effect.result(forwarding)

      if (Result.isFailure(forwarded)) return reject(502)

      const responseBody = yield* Effect.result(forwarded.success.arrayBuffer)

      if (Result.isFailure(responseBody)) return reject(502)

      const responseBytes = new Uint8Array(responseBody.success)

      return HttpServerResponse.uint8Array(responseBytes, {
        status: forwarded.success.status,
        contentType: forwarded.success.headers["content-type"] ?? contentType,
        headers: noStore,
      })
    })

    yield* router.add("POST", path, handler)
  })

  yield* addRoute("traces", tracesTransport)
  yield* addRoute("metrics", metricsTransport)
  yield* addRoute("logs", logsTransport)

  const traces = Predicate.isObject(telemetry.traces) ? telemetry.traces : null
  const sampleRate = Option.fromNullishOr(browser.sampleRate ?? traces?.sampleRate)
  const serviceName = `${telemetry.resource?.serviceName ?? options.application.name}-browser`

  const configuration = pipe(sampleRate, Option.match({
    onNone: () => BrowserTelemetryConfiguration.make({ endpoint: ingestPath, serviceName, signals }),
    onSome: (sampleRate) =>
      BrowserTelemetryConfiguration.make({ endpoint: ingestPath, serviceName, sampleRate, signals }),
  }))

  return Option.some(configuration)
})

const protocol = (signal: Signal, provider: ConfigProvider.ConfigProvider) => pipe(
  Config.schema(ProtocolSchema, `OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`),
  Config.option,
  Effect.flatMap(Option.match({
    onNone: () => Config.schema(ProtocolSchema, "OTEL_EXPORTER_OTLP_PROTOCOL"),
    onSome: Effect.succeed,
  })),
  Effect.provideService(ConfigProvider.ConfigProvider, provider),
)

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

const validateValue = <S extends Schema.Top>(schema: S, value: Option.Option<unknown>) => Option.match(value, {
  onNone: noValidation,
  onSome: (value) => pipe(
    Schema.decodeUnknownEffect(schema)(value),
    Effect.mapError((error) => new Config.ConfigError(error)),
    Effect.asVoid,
  ),
})

const validateOptional = <S extends Schema.Top>(schema: S, value: unknown) => {
  const optional = Option.fromNullishOr(value)

  return validateValue(schema, optional)
}

const validateDuration = (value: Option.Option<Duration.Input>) => Option.match(value, {
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
})

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
  yield* pipe(Option.fromNullishOr(traces?.exportInterval), validateDuration)
  yield* pipe(Option.fromNullishOr(traces?.shutdownTimeout), validateDuration)
  yield* pipe(Option.fromNullishOr(metrics?.exportInterval), validateDuration)
  yield* pipe(Option.fromNullishOr(metrics?.shutdownTimeout), validateDuration)
  yield* pipe(Option.fromNullishOr(logs?.exportInterval), validateDuration)
  yield* pipe(Option.fromNullishOr(logs?.shutdownTimeout), validateDuration)
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

const randomSample = (rate: number) => {
  const disabled = rate <= 0

  if (disabled) return !disabled

  const complete = rate >= 1

  if (complete) return complete

  const value = new Uint32Array(1)

  globalThis.crypto.getRandomValues(value)

  return (value[0] ?? 0) / 0x1_0000_0000 < rate
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
          onSome: randomSample,
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

    const annotateStatus = (response: HttpServerResponse.HttpServerResponse) =>
      Effect.annotateCurrentSpan("http.response.status_code", response.status)

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



const exporterLayer = Effect.fn("ApplicationTelemetry.exporterLayer")(function* (
  application: ApplicationIR,
  options: TelemetryOptions,
) {
  yield* validateOptions(options)

  const current = yield* ConfigProvider.ConfigProvider
  const overrideValues = environment(options)
  const overrides = ConfigProvider.fromEnvRecord(overrideValues)

  const defaultValues = Record.fromEntries([
    ["OTEL_SERVICE_NAME", application.name],
    ["OTEL_TRACES_EXPORTER", "otlp"],
    ["OTEL_METRICS_EXPORTER", "otlp"],
    ["OTEL_LOGS_EXPORTER", "otlp"],
    ["OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf"],
  ])

  const defaults = ConfigProvider.fromEnvRecord(defaultValues)
  const provider = pipe(overrides, ConfigProvider.orElse(current), ConfigProvider.orElse(defaults))
  const configuration = ConfigProvider.layer(provider)
  const traces = Predicate.isObject(options.traces) ? options.traces : null
  const metrics = Predicate.isObject(options.metrics) ? options.metrics : null
  const logs = Predicate.isObject(options.logs) ? options.logs : null
  const tracesDisabled = equalsFalse(options.traces, false)
  const metricsDisabled = equalsFalse(options.metrics, false)
  const logsDisabled = equalsFalse(options.logs, false)
  const noTransport = Option.none<OtlpTransport>()
  const activeTraces = tracesDisabled ? noTransport : yield* signalTransport("TRACES", options)
  const activeMetrics = metricsDisabled ? noTransport : yield* signalTransport("METRICS", options)
  const activeLogs = logsDisabled ? noTransport : yield* signalTransport("LOGS", options)
  const tracesActive = Option.isSome(activeTraces)
  const metricsActive = Option.isSome(activeMetrics)
  const logsActive = Option.isSome(activeLogs)
  const activeSignals = [tracesActive, metricsActive, logsActive]
  const active = Array.some(activeSignals, Boolean)

  if (!active) return Layer.empty

  const traceSerialization = serialization("TRACES", provider)

  const tracerBase = Option.isNone(activeTraces) ? Layer.empty : pipe(
    OtlpTracer.layerFromConfig({
      resource: options.resource,
      headers: traces?.headers ?? options.headers,
    }),
    Layer.provide(traceSerialization),
    Layer.provide(configuration),
  )

  const sampleRate = Option.fromNullishOr(traces?.sampleRate)
  const tracer = withTelemetryTracer(tracerBase, sampleRate, metricsActive)
  const metricSerialization = serialization("METRICS", provider)

  const metricExporter = Option.isNone(activeMetrics) ? Layer.empty : pipe(
    OtlpMetrics.layerFromConfig({
      resource: options.resource,
      headers: metrics?.headers ?? options.headers,
    }),
    Layer.provide(metricSerialization),
    Layer.provide(configuration),
  )

  const logSerialization = serialization("LOGS", provider)

  const logger = Option.isNone(activeLogs) ? Layer.empty : pipe(
    OtlpLogger.layerFromConfig({
      resource: options.resource,
      headers: logs?.headers ?? options.headers,
      excludeLogSpans: logs?.excludeLogSpans,
      mergeWithExisting: logs?.mergeWithExisting,
    }),
    Layer.provide(logSerialization),
    Layer.provide(configuration),
  )

  const runtimeMetrics = Option.isNone(activeMetrics) ? Layer.empty : Metric.enableRuntimeMetricsLayer

  const minimumLogLevel = pipe(
    Option.fromNullishOr(logs?.minimumLevel),
    Option.match({
      onNone: Function.constant(Layer.empty),
      onSome: Layer.succeed(References.MinimumLogLevel),
    }),
  )

  const minimumTraceLevel = pipe(
    Option.fromNullishOr(traces?.minimumLevel),
    Option.match({
      onNone: Function.constant(Layer.empty),
      onSome: Layer.succeed(Tracer.MinimumTraceLevel),
    }),
  )

  return Layer.mergeAll(tracer, metricExporter, logger, runtimeMetrics, minimumLogLevel, minimumTraceLevel)
})

const layer = (
  application: ApplicationIR,
  options: false | TelemetryOptions = Record.empty(),
) => {
  if (Predicate.isBoolean(options)) return Layer.empty

  const configured = exporterLayer(application, options)

  return Layer.unwrap(configured)
}

export const ApplicationTelemetry = {
  browserGateway: Effect.fn("ApplicationTelemetry.browserGateway")(browserGateway),
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  httpMiddleware: Effect.fn("ApplicationTelemetry.httpMiddleware")(httpMiddleware) as typeof httpMiddleware,
  layer,
}
