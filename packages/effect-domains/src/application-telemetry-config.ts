import { Array, Config, ConfigProvider, Duration, Effect, Equivalence, Function, Match, Option, Predicate, Record, Schema, flow, pipe } from "effect"
import type { LogLevel } from "effect"
import * as Headers from "effect/unstable/http/Headers"
import { OtlpMetrics, OtlpTracer } from "effect/unstable/observability"

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

const toMillisecondsString = flow(Duration.toMillis, String)
const milliseconds = (duration: Option.Option<Duration.Input>) => pipe(
  duration,
  Option.map(toMillisecondsString),
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

  const endpointFor = (signal: Signal) => {
    const endpoint = Option.map(baseEndpoint, (base) => signalEndpoint(base, signal))
    return Option.getOrUndefined(endpoint)
  }

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

export {
  type BrowserOptions,
  BrowserTelemetryConfiguration,
  BrowserTelemetrySignalsSchema,
  equalsFalse,
  equalsProtocol,
  environment,
  IngestPathSchema,
  type OtlpTransport,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
  ProtocolSchema,
  SampleRateSchema,
  type Signal,
  type SignalName,
  signalTransport,
  type TelemetryProtocol,
}
