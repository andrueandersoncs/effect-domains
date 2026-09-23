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

const validateRequestHeaders = (
  headers: HttpServerRequest.HttpServerRequest["headers"],
  maxRequestBytes: number,
) => {
  const noStore = Headers.set(Headers.empty, "cache-control", "no-store")
  const reject = (status: number) => HttpServerResponse.empty({ status, headers: noStore })
  const normalizeHeader = (value: string) => value.trim().toLowerCase()

  const contentEncoding = pipe(
    Option.fromUndefinedOr(headers["content-encoding"]),
    Option.map(normalizeHeader),
  )

  const identityEncoding = Equivalence.strictEqual<string>()
  const isCompressed = (value: string) => !identityEncoding(value, "identity")
  const compressed = Option.exists(contentEncoding, isCompressed)

  if (compressed) return Result.fail(reject(415))

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

  if (!supported) return Result.fail(reject(415))

  const contentLength = Number(headers["content-length"] ?? 0)
  const declaredOversized = Number.isFinite(contentLength) && contentLength > maxRequestBytes

  if (declaredOversized) return Result.fail(reject(413))

  return Result.succeed(contentType)
}

const forwardBrowserTelemetryRequest = Effect.fn("ApplicationTelemetry.forwardBrowserTelemetryRequest")(function* (
  request: HttpServerRequest.HttpServerRequest,
  transport: OtlpTransport,
  gatewayContext: Readonly<{
    isTrusted: (request: HttpServerRequest.HttpServerRequest) => boolean
    rateLimited: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<boolean>
    client: HttpClient.HttpClient
    maxRequestBytes: number
    reject: (status: number) => HttpServerResponse.HttpServerResponse
  }>,
) {
  if (!gatewayContext.isTrusted(request)) return gatewayContext.reject(403)

  const limited = yield* gatewayContext.rateLimited(request)

  if (limited) return gatewayContext.reject(429)

  const validation = validateRequestHeaders(request.headers, gatewayContext.maxRequestBytes)

  if (Result.isFailure(validation)) return validation.failure

  const contentType = validation.success
  const body = yield* Effect.result(request.arrayBuffer)

  if (Result.isFailure(body)) return gatewayContext.reject(400)
  if (body.success.byteLength > gatewayContext.maxRequestBytes) return gatewayContext.reject(413)

  const requestBytes = new Uint8Array(body.success)
  const requestWithBody = HttpClientRequest.bodyUint8Array(requestBytes, contentType)

  const outbound = pipe(
    HttpClientRequest.post(transport.endpoint),
    HttpClientRequest.setHeaders(transport.headers),
    requestWithBody,
  )

  const forwarding = gatewayContext.client.execute(outbound)
  const forwarded = yield* Effect.result(forwarding)

  if (Result.isFailure(forwarded)) return gatewayContext.reject(502)

  const responseBody = yield* Effect.result(forwarded.success.arrayBuffer)

  if (Result.isFailure(responseBody)) return gatewayContext.reject(502)

  const responseBytes = new Uint8Array(responseBody.success)

  return HttpServerResponse.uint8Array(responseBytes, {
    status: forwarded.success.status,
    contentType: forwarded.success.headers["content-type"] ?? contentType,
    headers: Headers.set(Headers.empty, "cache-control", "no-store"),
  })
})

const registerBrowserGatewayRoutes = Effect.fn("ApplicationTelemetry.registerBrowserGatewayRoutes")(function* (
  options: Readonly<{
    router: HttpRouter.HttpRouter
    client: HttpClient.HttpClient
    ingestPath: string
    maxRequestBytes: number
    requestsPerMinute: number
    allowedOrigins: ReadonlyArray<string> | undefined
    tracesTransport: Option.Option<OtlpTransport>
    metricsTransport: Option.Option<OtlpTransport>
    logsTransport: Option.Option<OtlpTransport>
  }>,
) {
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
    const address = Option.getOrElse(request.remoteAddress, Function.constant("unknown"))

    return yield* Ref.modify(
      windows,
      (currentWindows) => updateRateLimit(currentWindows, address, now, options.requestsPerMinute),
    )
  })

  const gatewayContext = {
    isTrusted,
    rateLimited,
    client: options.client,
    maxRequestBytes: options.maxRequestBytes,
    reject,
  }

  const addRoute = Effect.fn("ApplicationTelemetry.browserGatewayRoute")(function* (
    signal: SignalName,
    transport: Option.Option<OtlpTransport>,
  ) {
    if (Option.isNone(transport)) return

    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    const path = `${options.ingestPath}/v1/${signal}` as `/${string}`

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

  yield* registerBrowserGatewayRoutes({
    router,
    client,
    ingestPath,
    maxRequestBytes,
    requestsPerMinute,
    allowedOrigins: options.allowedOrigins,
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
