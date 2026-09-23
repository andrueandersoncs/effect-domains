import { Array, ConfigProvider, Effect, Function, Layer, Metric, Option, Predicate, Record, References, Tracer, pipe } from "effect"
import { OtlpLogger, OtlpMetrics, OtlpTracer } from "effect/unstable/observability"
import type { ApplicationIR } from "./application.ts"
import { equalsFalse, environment, type OtlpTransport, signalTransport, type TelemetryOptions } from "./application-telemetry-config.ts"
import { serialization, validateOptions, withTelemetryTracer } from "./application-telemetry-observation.ts"

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

  const minimumLogLevel = Option.match(
    Option.fromNullishOr(logs?.minimumLevel),
    {
      onNone: Function.constant(Layer.empty),
      onSome: Layer.succeed(References.MinimumLogLevel),
    },
  )

  const minimumTraceLevel = Option.match(
    Option.fromNullishOr(traces?.minimumLevel),
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
