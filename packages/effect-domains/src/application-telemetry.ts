import { Config, ConfigProvider, Duration, Effect, Layer, Option, Predicate, Record, Schema, flow, pipe } from "effect"
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability"
import type { ApplicationIR } from "./application.ts"

export type TelemetryOptions = Readonly<Omit<Parameters<typeof OtlpTracer.layer>[0], "url" | "context"> & Partial<{
  /** Full traces endpoint; unlike OTEL_EXPORTER_OTLP_ENDPOINT, no path is appended. */
  endpoint: string
  protocol: "http/protobuf" | "http/json"
}>>

const ProtocolSchema = Schema.Literals(["http/protobuf", "http/json"])
const EnvironmentValueSchema = Schema.UndefinedOr(Schema.String)
const EnvironmentSchema = Schema.Record(Schema.String, EnvironmentValueSchema)
const ResourceAttributesSchema = Config.Record(Schema.StringFromUriComponent, Schema.StringFromUriComponent)
const serializationLayers = { "http/protobuf": OtlpSerialization.layerProtobuf, "http/json": OtlpSerialization.layerJson }

const milliseconds = (duration: Option.Option<Duration.Input>) => pipe(
  duration,
  Option.map(flow(Duration.toMillis, String)),
  Option.getOrUndefined,
)

const layer = (application: ApplicationIR, options: false | TelemetryOptions = {}) => pipe(
  Effect.gen(function* () {
    if (Predicate.isBoolean(options)) return yield* Effect.succeed(Layer.empty)
    const current = yield* ConfigProvider.ConfigProvider
    const exportInterval = pipe(options.exportInterval, Option.fromNullishOr, milliseconds)
    const maxBatchSize = options.maxBatchSize?.toString()
    const shutdownTimeout = pipe(options.shutdownTimeout, Option.fromNullishOr, milliseconds)
    const resourceAttributes = yield* pipe(Config.schema(ResourceAttributesSchema, "OTEL_RESOURCE_ATTRIBUTES"), Config.option)
    const serviceName = pipe(resourceAttributes, Option.flatMap(Record.get("service.name")), Option.getOrElse(() => application.name))

    const overrideValues = EnvironmentSchema.make({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: options.endpoint,
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: options.protocol,
      OTEL_BSP_SCHEDULE_DELAY: exportInterval,
      OTEL_BSP_MAX_EXPORT_BATCH_SIZE: maxBatchSize,
      OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: shutdownTimeout,
    })

    const defaultValues = EnvironmentSchema.make({
      OTEL_SERVICE_NAME: serviceName,
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    })

    const overrides = ConfigProvider.fromEnvRecord(overrideValues)
    const defaults = ConfigProvider.fromEnvRecord(defaultValues)
    const provider = pipe(overrides, ConfigProvider.orElse(current), ConfigProvider.orElse(defaults))

    const protocol = pipe(
      Config.schema(ProtocolSchema, "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL"),
      Config.option,
      Effect.flatMap(Option.match({
        onNone: () => Config.schema(ProtocolSchema, "OTEL_EXPORTER_OTLP_PROTOCOL"),
        onSome: Effect.succeed,
      })),
    )

    const serialization = yield* pipe(
      protocol,
      Effect.provideService(ConfigProvider.ConfigProvider, provider),
      Effect.map((value) => serializationLayers[value]),
    )

    const configuration = ConfigProvider.layer(provider)

    return pipe(
      OtlpTracer.layerFromConfig({ resource: options.resource, headers: options.headers }),
      Layer.provide(serialization),
      Layer.provide(configuration),
    )
  }),
  Layer.unwrap,
)

export const ApplicationTelemetry = { layer }
