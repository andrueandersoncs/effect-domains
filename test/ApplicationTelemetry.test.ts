import { expect, it } from "@effect/vitest"
import { Array, Effect, Equivalence, Function, Layer, Metric, Option, Struct, pipe } from "effect"
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Application } from "effect-domains/application"
import { ApplicationTelemetry } from "effect-domains/application-telemetry"
import { CollectedSignal, decodeSignalBody, telemetryCollector } from "./telemetry-collector.ts"

const applicationDefinition = Application.define({ name: "telemetry-test", parts: [] })
const application = Effect.runSync(Application.compile(applicationDefinition))
const calls = Metric.counter("telemetry.test.calls", { incremental: true })
const samePath = Equivalence.strictEqual<string>()
const pathMatches = (path: string) => (signal: CollectedSignal) => samePath(signal.path, path)

it.effect("exports correlated traces, metrics, and logs from one application lifetime", Effect.fn(
  "ApplicationTelemetry.correlatedSignals",
)(function* () {
  const collector = yield* telemetryCollector()

  const telemetry = pipe(
    ApplicationTelemetry.layer(application, {
      endpoint: collector.endpoint,
      protocol: "http/json",
      resource: { serviceName: "telemetry-test", attributes: { "deployment.environment.name": "test" } },
      traces: { exportInterval: "10 millis", shutdownTimeout: "1 second" },
      metrics: { exportInterval: "10 millis", shutdownTimeout: "1 second" },
      logs: { exportInterval: "10 millis", shutdownTimeout: "1 second" },
    }),
    Layer.provide(FetchHttpClient.layer),
  )

  const program = Effect.gen(function* () {
    yield* Metric.update(calls, 1)
    yield* Effect.log("correlated-telemetry-test")
    yield* pipe(Effect.void, Effect.withSpan("RpcServer.telemetryTest"))

    const response = HttpServerResponse.text("ok")
    const httpApplication = Effect.succeed(response)
    const webRequest = new Request("http://localhost/health?sentinel=private")
    const request = HttpServerRequest.fromWeb(webRequest)

    yield* pipe(
      ApplicationTelemetry.httpMiddleware(httpApplication),
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    )
  })

  yield* pipe(
    program,
    Effect.withSpan("telemetry-test-span"),
    Effect.provide(telemetry),
    Effect.orDie,
    Effect.scoped,
  )

  const received = yield* collector.received

  const findBody = (path: string) => pipe(
    received,
    Array.findFirst(pathMatches(path)),
    Option.map(Struct.get("body")),
    Option.map(decodeSignalBody),
    Option.getOrElse(Function.constant("")),
  )

  const traces = findBody("/v1/traces")
  const metrics = findBody("/v1/metrics")
  const logs = findBody("/v1/logs")

  expect(received).toHaveLength(3)
  expect(traces).toContain("telemetry-test-span")
  expect(metrics).toContain("telemetry.test.calls")
  expect(metrics).toContain("rpc.server.call.duration")
  expect(metrics).toContain("http.server.request.duration")
  expect(traces).toContain("RpcServer.telemetryTest")
  expect(traces).toContain("http.server GET")
  const traceAssertion = expect(traces)
  traceAssertion.not.toContain("sentinel")
  expect(logs).toContain("correlated-telemetry-test")
  expect(logs).toContain("traceId")
  expect(logs).toContain("spanId")
  const signals = [traces, metrics, logs]
  const identifiesService = (body: string) => body.includes("telemetry-test")
  const allSignalsIdentifyService = Array.every(signals, identifiesService)
  expect(allSignalsIdentifyService).toBe(true)
}))
