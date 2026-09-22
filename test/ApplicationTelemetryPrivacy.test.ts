import { expect, it } from "@effect/vitest"
import { Array, Effect, Equivalence, HashSet, Layer, Option, Order, Schema, Struct, flow, pipe } from "effect"
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Application } from "effect-domains/application"
import { ApplicationTelemetry } from "effect-domains/application-telemetry"
import { CollectedSignal, decodeSignalBody, telemetryCollector } from "./telemetry-collector.ts"

const applicationDefinition = Application.define({ name: "telemetry-privacy-test", parts: [] })
const application = Effect.runSync(Application.compile(applicationDefinition))

class OtlpAttribute extends Schema.Class<OtlpAttribute>("OtlpAttribute")({
  key: Schema.String,
}) {}

const OtlpAttributesSchema = Schema.Array(OtlpAttribute)

class OtlpDataPoint extends Schema.Class<OtlpDataPoint>("OtlpDataPoint")({
  attributes: OtlpAttributesSchema,
}) {}

const OtlpDataPointsSchema = Schema.Array(OtlpDataPoint)

class OtlpHistogram extends Schema.Class<OtlpHistogram>("OtlpHistogram")({
  dataPoints: OtlpDataPointsSchema,
}) {}

const OptionalOtlpHistogramSchema = Schema.optionalKey(OtlpHistogram)

class OtlpMetric extends Schema.Class<OtlpMetric>("OtlpMetric")({
  name: Schema.String,
  histogram: OptionalOtlpHistogramSchema,
}) {}

const OtlpMetricArraySchema = Schema.Array(OtlpMetric)

class OtlpScopeMetrics extends Schema.Class<OtlpScopeMetrics>("OtlpScopeMetrics")({
  metrics: OtlpMetricArraySchema,
}) {}

const OtlpScopeMetricsArraySchema = Schema.Array(OtlpScopeMetrics)

class OtlpResourceMetrics extends Schema.Class<OtlpResourceMetrics>("OtlpResourceMetrics")({
  scopeMetrics: OtlpScopeMetricsArraySchema,
}) {}

const OtlpResourceMetricsArraySchema = Schema.Array(OtlpResourceMetrics)

class OtlpMetrics extends Schema.Class<OtlpMetrics>("OtlpMetrics")({
  resourceMetrics: OtlpResourceMetricsArraySchema,
}) {}

const OtlpMetricsJsonSchema = Schema.fromJsonString(OtlpMetrics)
const decodeMetrics = Schema.decodeUnknownEffect(OtlpMetricsJsonSchema)
const trimJson = (json: string) => json.trim()
const parseMetrics = flow(trimJson, decodeMetrics)
const hasMetricsPath = (signal: CollectedSignal) => Equivalence.strictEqual<string>()(signal.path, "/v1/metrics")
const hasRpcMetricName = (metric: OtlpMetric) => Equivalence.strictEqual<string>()(metric.name, "rpc.server.call.duration")
const dataPoints = (metric: OtlpMetric) => metric.histogram?.dataPoints ?? []
const serializeOtlpdatapoint = (point: OtlpDataPoint) => JSON.stringify(point.attributes)

it.effect("keeps generated telemetry payload-free and metric cardinality operation-bounded", Effect.fn(
  "ApplicationTelemetry.payloadPrivacy",
)(function* () {
  const collector = yield* telemetryCollector()

  const telemetry = pipe(
    ApplicationTelemetry.layer(application, {
      endpoint: collector.endpoint,
      protocol: "http/json",
      resource: { serviceName: "telemetry-privacy-test" },
      traces: { exportInterval: "1 hour", shutdownTimeout: "1 second" },
      metrics: { exportInterval: "1 hour", shutdownTimeout: "1 second" },
      logs: { exportInterval: "1 hour", shutdownTimeout: "1 second" },
    }),
    Layer.provide(FetchHttpClient.layer),
  )

  const ids = Array.makeBy(100, (index) => `private-id-${index}`)

  const invoke = Effect.fn("ApplicationTelemetryPrivacy.invoke")(function* (id: string) {
    const payload = JSON.stringify({
      email: `${id}@private.example`,
      body: `private-body-${id}`,
      token: `private-payload-token-${id}`,
    })

    const webRequest = new Request(`http://localhost/api/call?id=${id}`, {
      method: "POST",
      headers: {
        authorization: `Bearer private-token-${id}`,
        "content-type": "application/json",
      },
      body: payload,
    })

    const request = HttpServerRequest.fromWeb(webRequest)
    const httpApplication = HttpServerResponse.json({ result: null })

    yield* pipe(
      ApplicationTelemetry.httpMiddleware(httpApplication),
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    )

    yield* pipe(
      Effect.logInfo("RPC request completed"),
      Effect.annotateLogs({
        "rpc.method": "stable.operation",
        "rpc.system.name": "effect-rpc",
      }),
      Effect.withSpan("RpcServer.stable.operation"),
    )
  })

  yield* pipe(
    Effect.forEach(ids, invoke, { discard: true }),
    Effect.provide(telemetry),
    Effect.orDie,
    Effect.scoped,
  )

  const exported = yield* collector.received
  const bodies = Array.map(exported, Struct.get("body"))
  const decodedBodies = Array.map(bodies, decodeSignalBody)
  const serialized = Array.join(decodedBodies, "\n")
  const serializedAssertion = expect(serialized)

  serializedAssertion.not.toContain("private-id-")
  serializedAssertion.not.toContain("private-token-")
  serializedAssertion.not.toContain("private.example")
  serializedAssertion.not.toContain("private-body-")
  serializedAssertion.not.toContain("private-payload-token-")

  const metricSignals = Array.filter(exported, hasMetricsPath)
  const metricBodies = Array.map(metricSignals, Struct.get("body"))
  const metricJson = Array.map(metricBodies, decodeSignalBody)
  const metricPayloads = yield* Effect.forEach(metricJson, parseMetrics)
  const resources = Array.flatMap(metricPayloads, Struct.get("resourceMetrics"))
  const scopes = Array.flatMap(resources, Struct.get("scopeMetrics"))
  const metrics = Array.flatMap(scopes, Struct.get("metrics"))
  const rpcMetrics = Array.filter(metrics, hasRpcMetricName)
  const rpcPoints = Array.flatMap(rpcMetrics, dataPoints)
  const serializedPoints = Array.map(rpcPoints, serializeOtlpdatapoint)
  const series = HashSet.fromIterable(serializedPoints)
  const seriesCount = HashSet.size(series)

  expect(seriesCount).toBe(1)

  const firstPoint = pipe(Array.head(rpcPoints), Option.getOrThrow)
  const keys = Array.map(firstPoint.attributes, Struct.get("key"))
  const sortedKeys = Array.sort(keys, Order.String)

  expect(sortedKeys).toEqual(["rpc.method", "rpc.system.name", "unit"])
}))
