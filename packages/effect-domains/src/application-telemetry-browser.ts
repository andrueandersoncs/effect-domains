import { Array, Effect, Equivalence, Function, HashMap, Option, Predicate, Record, Ref, Result, Schema, pipe } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Headers from "effect/unstable/http/Headers"
import type { ApplicationIR } from "./application.ts"
import { BrowserTelemetryConfiguration, type BrowserOptions, BrowserTelemetrySignalsSchema, equalsFalse, type OtlpTransport, signalTransport, type SignalName, type TelemetryOptions } from "./application-telemetry-config.ts"

class GatewayWindow extends Schema.Class<GatewayWindow>("GatewayWindow")({
  startedAt: Schema.Number,
  count: Schema.Int,
}) {}

const updateRateLimit = (
  currentWindows: HashMap.HashMap<string, GatewayWindow>,
  address: string,
  now: number,
  requestsPerMinute: number,
) => {
  const cutoff = now - 60_000
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
}

const noStore = Headers.set(Headers.empty, "cache-control", "no-store")
const reject = (status: number) => HttpServerResponse.empty({ status, headers: noStore })

const validateRequestHeaders = (
  headers: HttpServerRequest.HttpServerRequest["headers"],
  maxRequestBytes: number,
) => {
  const normalizeHeader = (value: string) => value.trim().toLowerCase()

  const contentEncoding = pipe(
    Option.fromUndefinedOr(headers["content-encoding"]),
    Option.map(normalizeHeader),
  )

  const identityEncoding = Equivalence.strictEqual<string>()
  const isCompressed = (value: string) => !identityEncoding(value, "identity")
  const compressed = Option.exists(contentEncoding, isCompressed)

  if (compressed) {
    const response = reject(415)

    return Result.fail(response)
  }

  const normalizeContentType = (value: string) => {
    const parts = value.split(";", 1)
    const mediaType = pipe(Array.head(parts), Option.getOrElse(Function.constant("")))

    return normalizeHeader(mediaType)
  }

  const contentType = pipe(
    Option.fromUndefinedOr(headers["content-type"]),
    Option.map(normalizeContentType),
    Option.getOrElse(Function.constant("")),
  )

  const protobuf = Equivalence.strictEqual<string>()(contentType, "application/x-protobuf")
  const json = Equivalence.strictEqual<string>()(contentType, "application/json")
  const supported = protobuf || json

  if (!supported) {
    const response = reject(415)

    return Result.fail(response)
  }

  const contentLength = Number(headers["content-length"] ?? 0)
  const declaredOversized = Number.isFinite(contentLength) && contentLength > maxRequestBytes

  if (!declaredOversized) return Result.succeed(contentType)

  const response = reject(413)

  return Result.fail(response)
}

const forwardBrowserTelemetryRequest = Effect.fn("ApplicationTelemetry.forwardBrowserTelemetryRequest")(function* (
  request: HttpServerRequest.HttpServerRequest,
  transport: OtlpTransport,
  gatewayContext: Readonly<{
    allowedOrigins: Option.Option<ReadonlyArray<string>>
    rateLimited: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<boolean>
    client: HttpClient.HttpClient
    maxRequestBytes: number
  }>,
) {
  if (!isTrustedGatewayRequest(request, gatewayContext.allowedOrigins)) return reject(403)

  const limited = yield* gatewayContext.rateLimited(request)

  if (limited) return reject(429)

  const validation = validateRequestHeaders(request.headers, gatewayContext.maxRequestBytes)

  if (Result.isFailure(validation)) return validation.failure

  const body = yield* Effect.result(request.arrayBuffer)

  if (Result.isFailure(body)) return reject(400)
  if (body.success.byteLength > gatewayContext.maxRequestBytes) return reject(413)

  const requestBytes = new Uint8Array(body.success)
  const requestWithBody = HttpClientRequest.bodyUint8Array(requestBytes, validation.success)

  const outbound = pipe(
    HttpClientRequest.post(transport.endpoint),
    HttpClientRequest.setHeaders(transport.headers),
    requestWithBody,
  )

  const forwarding = gatewayContext.client.execute(outbound)
  const forwarded = yield* Effect.result(forwarding)

  if (Result.isFailure(forwarded)) return reject(502)

  const responseBody = yield* Effect.result(forwarded.success.arrayBuffer)

  if (Result.isFailure(responseBody)) return reject(502)

  const responseBytes = new Uint8Array(responseBody.success)

  return HttpServerResponse.uint8Array(responseBytes, {
    status: forwarded.success.status,
    contentType: forwarded.success.headers["content-type"] ?? validation.success,
    headers: noStore,
  })
})

const isTrustedGatewayRequest = (
  request: HttpServerRequest.HttpServerRequest,
  allowedOrigins: Option.Option<ReadonlyArray<string>>,
) => {
  const trustedFetchSite = !Equivalence.strictEqual<string>()(request.headers["sec-fetch-site"] ?? "", "cross-site")
  const origin = Option.fromUndefinedOr(request.headers.origin)

  return trustedFetchSite && Option.match(origin, {
    onNone: Function.constant(true),
    onSome: (value) => {
      const url = HttpServerRequest.toURL(request)

      return Option.exists(url, (candidate) => {
        const sameOrigin = Equivalence.strictEqual<string>()(value, candidate.origin)
        const explicitlyAllowed = Option.exists(allowedOrigins, (allowed) => Array.contains(allowed, value))

        return sameOrigin || explicitlyAllowed
      })
    },
  })
}

const registerBrowserGatewayRoutes = Effect.fn("ApplicationTelemetry.registerBrowserGatewayRoutes")(function* (
  options: Readonly<{
    router: HttpRouter.HttpRouter
    client: HttpClient.HttpClient
    ingestPath: `/${string}`
    maxRequestBytes: number
    requestsPerMinute: number
    allowedOrigins: Option.Option<ReadonlyArray<string>>
    tracesTransport: Option.Option<OtlpTransport>
    metricsTransport: Option.Option<OtlpTransport>
    logsTransport: Option.Option<OtlpTransport>
  }>,
) {
  const emptyWindows = HashMap.empty<string, GatewayWindow>()
  const windows = yield* Ref.make(emptyWindows)

  const rateLimited = Effect.fn("ApplicationTelemetry.browserGatewayRateLimit")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const now = Date.now()
    const address = Option.getOrElse(request.remoteAddress, Function.constant("unknown"))

    return yield* Ref.modify(
      windows,
      (currentWindows) => updateRateLimit(currentWindows, address, now, options.requestsPerMinute),
    )
  })

  const gatewayContext = {
    allowedOrigins: options.allowedOrigins,
    rateLimited,
    client: options.client,
    maxRequestBytes: options.maxRequestBytes,
  }

  const addRoute = Effect.fn("ApplicationTelemetry.browserGatewayRoute")(function* (
    signal: SignalName,
    transport: Option.Option<OtlpTransport>,
  ) {
    if (Option.isNone(transport)) return

    const path: `/${string}` = `${options.ingestPath}/v1/${signal}`

    const handler = Effect.fn("ApplicationTelemetry.browserGateway.forward")(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      return yield* forwardBrowserTelemetryRequest(request, transport.value, gatewayContext)
    })

    yield* options.router.add("POST", path, handler)
  })

  yield* addRoute("traces", options.tracesTransport)
  yield* addRoute("metrics", options.metricsTransport)
  yield* addRoute("logs", options.logsTransport)
})

const browserGateway = Effect.fn("ApplicationTelemetry.browserGateway")(function* (
  options: Readonly<{ application: ApplicationIR }> & Readonly<Partial<{
    telemetry: TelemetryOptions | null
    allowedOrigins: ReadonlyArray<string>
  }>>,
) {
  const telemetryOption = Option.fromNullishOr(options.telemetry)

  if (Option.isNone(telemetryOption)) return Option.none<BrowserTelemetryConfiguration>()

  const { value: telemetry } = telemetryOption
  const emptyBrowser: BrowserOptions = Record.empty()
  const browser = Predicate.isObject(telemetry.browser) ? telemetry.browser : emptyBrowser
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
  const allowedOrigins = Option.fromUndefinedOr(options.allowedOrigins)


  yield* registerBrowserGatewayRoutes({
    router,
    client,
    ingestPath,
    maxRequestBytes,
    requestsPerMinute,
    allowedOrigins,
    tracesTransport,
    metricsTransport,
    logsTransport,
  })

  const traces = Predicate.isObject(telemetry.traces) ? telemetry.traces : null
  const configuredSampleRate = browser.sampleRate ?? traces?.sampleRate
  const sampleRate = Option.fromNullishOr(configuredSampleRate)
  const serviceName = `${telemetry.resource?.serviceName ?? options.application.name}-browser`

  const configuration = pipe(sampleRate, Option.match({
    onNone: () => BrowserTelemetryConfiguration.make({ endpoint: ingestPath, serviceName, signals }),
    onSome: (sampleRate) =>
      BrowserTelemetryConfiguration.make({ endpoint: ingestPath, serviceName, sampleRate, signals }),
  }))

  return Option.some(configuration)
})

export { browserGateway }
