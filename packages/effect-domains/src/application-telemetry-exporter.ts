import { Array, Config, ConfigProvider, Duration, Effect, Function, Layer, Metric, Option, Predicate, Record, References, Schema, Tracer, pipe } from "effect"
import { OtlpLogger, OtlpMetrics, OtlpSerialization, OtlpTracer } from "effect/unstable/observability"
import type { ApplicationIR } from "./application.ts"
import { equalsFalse, equalsProtocol, environment, IngestPathSchema, type OtlpTransport, PositiveFiniteSchema, PositiveIntegerSchema, ProtocolSchema, SampleRateSchema, type Signal, signalTransport, type TelemetryOptions, type TelemetryProtocol } from "./application-telemetry-config.ts"
import { withTelemetryTracer } from "./application-telemetry-observation.ts"
import { TelemetryOptionsError, telemetryOptionsError } from "./telemetry-options-error.ts"

const validateValue = Effect.fn("ApplicationTelemetry.validateValue")(function* <S extends Schema.Top>(
  schema: S,
  value: Option.Option<unknown>,
) {
  if (Option.isNone(value)) return

  yield* pipe(
    Schema.decodeUnknownEffect(schema)(value.value),
    Effect.mapError(telemetryOptionsError),
    Effect.asVoid,
  )
})

const validateOptional = Effect.fn("ApplicationTelemetry.validateOptional")(function* <S extends Schema.Top>(
  schema: S,
  value: unknown,
) {
  const optional = Option.fromNullishOr(value)

  return yield* validateValue(schema, optional)
})

const invalidDuration = () => TelemetryOptionsError.make({ reason: "telemetry duration must be a valid Duration.Input" })

const validateDuration = Effect.fn("ApplicationTelemetry.validateDuration")(function* (
  optional: Option.Option<Duration.Input>,
) {
  if (Option.isNone(optional)) return

  const parsed = Duration.fromInput(optional.value)
  const duration = yield* Effect.fromOption(parsed, invalidDuration)
  const millis = Duration.toMillis(duration)
  const measured = Option.some(millis)

  yield* validateValue(PositiveFiniteSchema, measured)
})

const validateDurationInput = Effect.fn("ApplicationTelemetry.validateDurationInput")(function* (
  value: unknown,
) {
  const optional = Option.fromNullishOr(value)

  yield* validateDuration(optional)
})

const validateOptionValues = Effect.fn("ApplicationTelemetry.validateOptionValues")(function* <S extends Schema.Top>(
  schema: S,
  values: ReadonlyArray<unknown>,
) {
  const validate = (value: unknown) => validateOptional(schema, value)

  yield* Effect.forEach(values, validate, { concurrency: 1, discard: true })
})

const validateOptions = Effect.fn("ApplicationTelemetry.validateOptions")(function* (options: TelemetryOptions) {
  const traces = Predicate.isObject(options.traces) ? options.traces : null
  const metrics = Predicate.isObject(options.metrics) ? options.metrics : null
  const logs = Predicate.isObject(options.logs) ? options.logs : null
  const browser = Predicate.isObject(options.browser) ? options.browser : null
  const endpoints = [options.endpoint, traces?.endpoint, metrics?.endpoint, logs?.endpoint]
  const resourceNames = [options.resource?.serviceName, options.resource?.serviceVersion]
  const sampleRates = [traces?.sampleRate, browser?.sampleRate]

  const positiveIntegers = [
    traces?.maxBatchSize,
    logs?.maxBatchSize,
    browser?.maxRequestBytes,
    browser?.requestsPerMinute,
  ]

  const ingestPaths = [browser?.ingestPath]

  const durations = [
    traces?.exportInterval,
    traces?.shutdownTimeout,
    metrics?.exportInterval,
    metrics?.shutdownTimeout,
    logs?.exportInterval,
    logs?.shutdownTimeout,
  ]

  yield* validateOptionValues(Schema.URLFromString, endpoints)
  yield* validateOptionValues(Schema.NonEmptyString, resourceNames)
  yield* validateOptionValues(SampleRateSchema, sampleRates)
  yield* validateOptionValues(PositiveIntegerSchema, positiveIntegers)
  yield* validateOptionValues(IngestPathSchema, ingestPaths)

  yield* Effect.forEach(durations, validateDurationInput, { concurrency: 1, discard: true })
})

const protocol = Effect.fn("ApplicationTelemetry.protocol")(function* (
  signal: Signal,
  provider: ConfigProvider.ConfigProvider,
) {
  const signalConfig = Config.schema(ProtocolSchema, `OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`)
  const optionalSignalConfig = Config.option(signalConfig)

  const selectConfig = Option.match({
    onNone: () => Config.schema(ProtocolSchema, "OTEL_EXPORTER_OTLP_PROTOCOL"),
    onSome: Effect.succeed,
  })

  const configured = Effect.flatMap(optionalSignalConfig, selectConfig)

  return yield* Effect.provideService(configured, ConfigProvider.ConfigProvider, provider)
})

const serialization = (signal: Signal, provider: ConfigProvider.ConfigProvider) => {
  const configured = protocol(signal, provider)

  const selectLayer = (value: TelemetryProtocol) => equalsProtocol(value, "http/protobuf")
    ? OtlpSerialization.layerProtobuf
    : OtlpSerialization.layerJson

  const selected = Effect.map(configured, selectLayer)

  return Layer.unwrap(selected)
}

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
  const tracer = withTelemetryTracer(tracerBase, sampleRate, metricsActive, globalThis.crypto)
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
  const minimumLogLevelOption = Option.fromNullishOr(logs?.minimumLevel)

  const minimumLogLevel = Option.match(
    minimumLogLevelOption,
    {
      onNone: Function.constant(Layer.empty),
      onSome: Layer.succeed(References.MinimumLogLevel),
    },
  )

  const minimumTraceLevelOption = Option.fromNullishOr(traces?.minimumLevel)

  const minimumTraceLevel = Option.match(
    minimumTraceLevelOption,
    {
      onNone: Function.constant(Layer.empty),
      onSome: Layer.succeed(Tracer.MinimumTraceLevel),
    },
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

export { exporterLayer, layer }
