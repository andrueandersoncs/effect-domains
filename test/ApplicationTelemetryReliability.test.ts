import { expect, it } from "@effect/vitest"
import { Array, Clock, Effect, Equivalence, HashMap, HashSet, Layer, Metric, Struct, pipe } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Application } from "effect-domains/application"
import { ApplicationTelemetry } from "effect-domains/application-telemetry"
import { type CollectedSignal, telemetryCollector } from "./telemetry-collector.ts"

const applicationDefinition = Application.define({ name: "telemetry-reliability-test", parts: [] })
const application = Effect.runSync(Application.compile(applicationDefinition))
const events = Metric.counter("telemetry.reliability.events", { incremental: true })
const expectedSignals = HashSet.make("/v1/traces", "/v1/metrics", "/v1/logs")

const telemetryLayer = (endpoint: string, shutdownTimeout: "500 millis" | "100 millis" = "500 millis") => pipe(
  ApplicationTelemetry.layer(application, {
    endpoint,
    protocol: "http/json",
    traces: { exportInterval: "20 millis", shutdownTimeout },
    metrics: { exportInterval: "20 millis", shutdownTimeout },
    logs: { exportInterval: "20 millis", shutdownTimeout },
  }),
  Layer.provide(FetchHttpClient.layer),
)

const emit = pipe(
  Effect.gen(function* () {
    yield* Metric.update(events, 1)
    yield* Effect.logInfo("telemetry reliability probe")
  }),
  Effect.withSpan("telemetry-reliability-probe"),
)

const sameStatus = Equivalence.strictEqual<number>()
const acceptedPath = (signal: CollectedSignal) => sameStatus(signal.status, 200)
const sufficientAttempts = (count: number) => count >= 3

it.live("keeps application work successful through throttling and collector failure, then recovers", Effect.fn(
  "ApplicationTelemetry.recovers",
)(function* () {
  const collector = yield* telemetryCollector("retry-twice")

  const program = Effect.gen(function* () {
    yield* emit
    yield* Effect.sleep("2 seconds")
    return "application-success"
  })

  const layer = telemetryLayer(collector.endpoint)

  const result = yield* pipe(
    program,
    Effect.provide(layer),
    Effect.scoped,
  )

  const received = yield* collector.received
  const accepted = pipe(received, Array.filter(acceptedPath), Array.map(Struct.get("path")), HashSet.fromIterable)
  const attempts = yield* collector.attempts
  const attemptValues = HashMap.values(attempts)
  const attemptCounts = Array.fromIterable(attemptValues)

  expect(result).toBe("application-success")
  expect(accepted).toEqual(expectedSignals)
  const enoughAttempts = Array.every(attemptCounts, sufficientAttempts)
  expect(enoughAttempts).toBe(true)
}))

it.live("flushes all signals on graceful scope close", Effect.fn(
  "ApplicationTelemetry.gracefulFlush",
)(function* () {
  const collector = yield* telemetryCollector()

  const layer = pipe(
    ApplicationTelemetry.layer(application, {
      endpoint: collector.endpoint,
      protocol: "http/json",
      traces: { exportInterval: "1 day", shutdownTimeout: "1 second" },
      metrics: { exportInterval: "1 day", shutdownTimeout: "1 second" },
      logs: { exportInterval: "1 day", shutdownTimeout: "1 second" },
    }),
    Layer.provide(FetchHttpClient.layer),
  )

  yield* pipe(emit, Effect.provide(layer), Effect.scoped)

  const received = yield* collector.received
  const accepted = pipe(received, Array.map(Struct.get("path")), HashSet.fromIterable)
  expect(accepted).toEqual(expectedSignals)
}))

it.live("does not surface connection refusal as an application failure", Effect.fn(
  "ApplicationTelemetry.connectionRefusal",
)(function* () {
  const layer = telemetryLayer("http://127.0.0.1:1", "100 millis")
  const startedAt = yield* Clock.currentTimeMillis

  const result = yield* pipe(
    Effect.as(emit, "application-success"),
    Effect.provide(layer),
    Effect.scoped,
    Effect.timeout("1 second"),
  )

  const endedAt = yield* Clock.currentTimeMillis
  const elapsed = endedAt - startedAt
  expect(result).toBe("application-success")
  expect(elapsed).toBeLessThan(1_000)
}))

it.live("bounds shutdown when a collector never responds", Effect.fn(
  "ApplicationTelemetry.boundedShutdown",
)(function* () {
  const collector = yield* telemetryCollector("slow")
  const startedAt = yield* Clock.currentTimeMillis
  const layer = telemetryLayer(collector.endpoint, "100 millis")

  yield* pipe(
    emit,
    Effect.provide(layer),
    Effect.scoped,
    Effect.timeout("1 second"),
  )

  const endedAt = yield* Clock.currentTimeMillis
  const elapsed = endedAt - startedAt
  expect(elapsed).toBeLessThan(1_000)
}))
