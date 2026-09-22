import { expect, it } from "@effect/vitest"
import { Array, Effect, Layer, Option, pipe } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { Application } from "effect-domains/application"
import { ApplicationTelemetry } from "effect-domains/application-telemetry"
import { telemetryCollector } from "./telemetry-collector.ts"

const applicationDefinition = Application.define({ name: "telemetry-browser-test", parts: [] })
const application = Effect.runSync(Application.compile(applicationDefinition))

it.effect("forwards bounded same-origin browser OTLP without exposing collector credentials", Effect.fn(
  "ApplicationTelemetry.browserGateway",
)(function* () {
  const collector = yield* telemetryCollector()

  const registerRoutes = Effect.fn("ApplicationTelemetryBrowser.registerRoutes")(function* () {
    const configured = yield* ApplicationTelemetry.browserGateway({
      application,
      telemetry: {
        endpoint: collector.endpoint,
        headers: { authorization: "Bearer collector-secret" },
        logs: false,
        browser: { maxRequestBytes: 8, requestsPerMinute: 10 },
      },
    })

    expect(configured).toMatchObject({
      _tag: "Some",
      value: {
        endpoint: "/otel",
        serviceName: "telemetry-browser-test-browser",
        signals: { traces: true, metrics: true, logs: false },
      },
    })
  })

  const routeRegistration = registerRoutes()
  const routes = Layer.effectDiscard(routeRegistration)

  const providedRoutes = pipe(
    routes,
    Layer.provide(FetchHttpClient.layer),
  ) as Layer.Layer<never, unknown, HttpRouter.HttpRouter>

  const server = HttpRouter.toWebHandler(providedRoutes, { disableLogger: true })
  yield* Effect.addFinalizer(() => Effect.promise(() => server.dispose()))

  const baseHeaders = new Headers({
    "content-type": "application/x-protobuf",
    origin: "http://localhost",
    "sec-fetch-site": "same-origin",
    cookie: "session=browser-secret",
    authorization: "Bearer browser-secret",
  })

  const acceptedBytes = new Uint8Array([1, 2, 3])

  const acceptedRequest = new Request("http://localhost/otel/v1/traces", {
    method: "POST",
    headers: baseHeaders,
    body: acceptedBytes,
  })

  const accepted = yield* Effect.promise(() => server.handler(acceptedRequest))
  expect(accepted.status).toBe(200)

  const received = yield* collector.received
  const first = pipe(received, Array.head, Option.getOrThrow)
  expect(received).toHaveLength(1)

  expect(first).toMatchObject({
    path: "/v1/traces",
    authorization: "Bearer collector-secret",
    body: acceptedBytes,
  })

  const crossOriginBytes = new Uint8Array([4])
  const crossOriginHeaders = new Headers(baseHeaders)
  crossOriginHeaders.set("origin", "http://attacker.example")
  crossOriginHeaders.set("sec-fetch-site", "cross-site")

  const crossOriginRequest = new Request("http://localhost/otel/v1/traces", {
    method: "POST",
    headers: crossOriginHeaders,
    body: crossOriginBytes,
  })

  const crossOrigin = yield* Effect.promise(() => server.handler(crossOriginRequest))
  expect(crossOrigin.status).toBe(403)

  const oversizedBytes = new Uint8Array(9)

  const oversizedRequest = new Request("http://localhost/otel/v1/metrics", {
    method: "POST",
    headers: baseHeaders,
    body: oversizedBytes,
  })

  const oversized = yield* Effect.promise(() => server.handler(oversizedRequest))
  expect(oversized.status).toBe(413)

  const unsupportedBytes = new Uint8Array([1])
  const unsupportedHeaders = new Headers(baseHeaders)
  unsupportedHeaders.set("content-type", "text/plain")

  const unsupportedRequest = new Request("http://localhost/otel/v1/metrics", {
    method: "POST",
    headers: unsupportedHeaders,
    body: unsupportedBytes,
  })

  const unsupported = yield* Effect.promise(() => server.handler(unsupportedRequest))
  expect(unsupported.status).toBe(415)

  const compressedBytes = new Uint8Array([1])
  const compressedHeaders = new Headers(baseHeaders)
  compressedHeaders.set("content-encoding", "gzip")

  const compressedRequest = new Request("http://localhost/otel/v1/metrics", {
    method: "POST",
    headers: compressedHeaders,
    body: compressedBytes,
  })

  const compressed = yield* Effect.promise(() => server.handler(compressedRequest))
  expect(compressed.status).toBe(415)

  const disabledBytes = new Uint8Array([1])

  const disabledRequest = new Request("http://localhost/otel/v1/logs", {
    method: "POST",
    headers: baseHeaders,
    body: disabledBytes,
  })

  const disabled = yield* Effect.promise(() => server.handler(disabledRequest))
  expect(disabled.status).toBe(404)

  const finalReceived = yield* collector.received
  expect(finalReceived).toHaveLength(1)
}))
