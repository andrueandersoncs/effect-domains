import { Array, Effect, Equivalence, Function, HashMap, HashSet, Layer, Option, Result, Schema, Struct, pipe } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { type Rpc, type RpcGroup } from "effect/unstable/rpc"
import type { ApplicationUiPresentation } from "@effect-domains/application-ui/contract"
import type { ApplicationIR } from "./application.ts"
import { applicationUiPaths } from "./application-ui-paths.ts"
import { ApplicationInspect } from "./application-inspect.ts"
import { compileUnaryRpc } from "./rpc-contract.ts"
import { inProcessClient, type UnaryRpc } from "./rpc-in-process.ts"
import { ApplicationTelemetry, type TelemetryOptions } from "./application-telemetry.ts"

export type ApplicationUiOptions = Readonly<Partial<{
  path: string
  presentation: ApplicationUiPresentation
  allowedOrigins: ReadonlyArray<string>
}>>

class ApplicationUiDefinitionError extends Schema.TaggedError<ApplicationUiDefinitionError>()("ApplicationUiDefinitionError", {
  reason: Schema.String,
}) {}

const CallSchema = Schema.Struct({ operation: Schema.String, input: Schema.Json })

interface Call extends Schema.Schema.Type<typeof CallSchema> {}

const responseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
}

const internalResponse = HttpServerResponse.text('{"error":{"message":"Operation failed due to an internal server error."}}', {
  status: 500,
  contentType: "application/json",
  headers: responseHeaders,
})

const internalFailure = () => Effect.succeed(internalResponse)

const jsonResponse = (status: number) => (body: unknown) => pipe(
  HttpServerResponse.json(body, { status, headers: responseHeaders }),
  Effect.catch(internalFailure),
)

const successResponse = jsonResponse(200)
const declaredErrorResponse = jsonResponse(422)

const failure = (status: number, message: string) => pipe(
  HttpServerResponse.json({ error: { message } }, { status, headers: responseHeaders }),
  Effect.catch(internalFailure),
)

const loopbackHosts = HashSet.make("localhost", "127.0.0.1", "[::1]")


const register = Effect.fn("ApplicationUi.register")(function* (options: Readonly<{
  application: ApplicationIR
  javascript: string
  stylesheet: string
}> & Readonly<Partial<{ telemetry: TelemetryOptions }>> & ApplicationUiOptions) {
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const path = (options.path ?? "/") as `/${string}`

  if (!/^\/$|^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(path)) {
    return yield* ApplicationUiDefinitionError.make({ reason: "Application UI path must be root or contain nonempty URL path segments without a trailing slash" })
  }

  const router = yield* HttpRouter.HttpRouter
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const { client, withHandlerContext } = yield* inProcessClient(options.application.group as RpcGroup.RpcGroup<UnaryRpc>)
  const procedures = options.application.group.requests.values()

  const entries = yield* Effect.forEach(procedures, Effect.fn("ApplicationUi.compileOperation")(function* (procedure) {
    const compiled = compileUnaryRpc(procedure)

    const contract = yield* Effect.fromOption(
      compiled,
      () => ApplicationUiDefinitionError.make({ reason: `Application UI operations must be unary: ${procedure._tag}` }),
    )

    const decode = Schema.decodeUnknownEffect(contract.payloadSchema)
    const encodeResult = pipe(Schema.Struct({ result: contract.successSchema }), Schema.encodeUnknownEffect)
    const encodeError = pipe(Schema.Struct({ error: contract.errorSchema }), Schema.encodeUnknownEffect)
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    const withCodecContext = withHandlerContext(procedure as UnaryRpc)

    const invoke = Effect.fn("ApplicationUi.invoke")(function* (input: unknown, request: HttpServerRequest.HttpServerRequest) {
      const decoded = yield* pipe(decode(input), withCodecContext, Effect.result)

      if (Result.isFailure(decoded)) return yield* failure(400, `Invalid input for ${contract._tag}: ${decoded.failure.message}`)

      return yield* pipe(
        client(contract._tag, decoded.success, { headers: request.headers }),
        Effect.matchEffect({
          onFailure: (error) => pipe(encodeError({ error }), withCodecContext, Effect.flatMap(declaredErrorResponse), Effect.catch(internalFailure)),
          onSuccess: (result) => pipe(encodeResult({ result }), withCodecContext, Effect.flatMap(successResponse), Effect.catch(internalFailure)),
        }),
      )
    })

    const execute = (input: unknown, request: HttpServerRequest.HttpServerRequest) => pipe(
      invoke(input, request),
      Effect.catchDefect(internalFailure),
    )

    return [contract._tag, execute] as const
  }))


  const invocations = HashMap.fromIterable(entries)
  const inspection = ApplicationInspect.describe(options.application)
  const metadata = Struct.assign(inspection, { presentation: options.presentation ?? {} })

  const browserTelemetry = yield* ApplicationTelemetry.browserGateway({
    application: options.application,
    telemetry: options.telemetry,
    allowedOrigins: options.allowedOrigins,
  })


  const escapeAttribute = (value: string) => value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")

  const serializeBrowsertelemetry = (browser: Option.Option.Value<typeof browserTelemetry>) => {
    const encoded = JSON.stringify(browser)

    return ` data-telemetry="${escapeAttribute(encoded)}"`
  }

  const noBrowserTelemetryAttribute = Function.constant("")

  const telemetryAttribute = Option.match(browserTelemetry, {
    onNone: noBrowserTelemetryAttribute,
    onSome: serializeBrowsertelemetry,
  })

  const {
    javascript: clientPath,
    stylesheet: stylesheetPath,
    api: apiPath,
    call: callPath,
  } = applicationUiPaths(path)

  const document = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Effect Domains Application</title><link rel="stylesheet" href="${stylesheetPath}"><script type="module" src="${clientPath}"></script></head><body><div id="app" data-base="${path}"${telemetryAttribute}></div><noscript>This application requires JavaScript.</noscript></body></html>`

  const html = pipe(HttpServerResponse.html(document), HttpServerResponse.setHeaders(responseHeaders))
  const javascript = HttpServerResponse.text(options.javascript, { contentType: "text/javascript", headers: responseHeaders })
  const stylesheet = HttpServerResponse.text(options.stylesheet, { contentType: "text/css", headers: responseHeaders })
  const metadataResponse = successResponse(metadata)

  yield* router.add("GET", path, html)
  yield* router.add("GET", clientPath, javascript)
  yield* router.add("GET", stylesheetPath, stylesheet)
  yield* router.add("GET", apiPath, metadataResponse)

  const receive = Effect.fn("ApplicationUi.receive")(function* (request: HttpServerRequest.HttpServerRequest) {
    const origin = Option.fromNullishOr(request.headers.origin)
    const url = HttpServerRequest.toURL(request)
    const crossSite = Equivalence.strictEqual<string>()(request.headers["sec-fetch-site"] ?? "", "cross-site")
    const allowedOrigins = Option.fromNullishOr(options.allowedOrigins)

    const trustedOrigin = Option.exists(url, (value) => {
      const matches = Option.contains(origin, value.origin)

      const trusted = Option.match(allowedOrigins, {
        onNone: () => HashSet.has(loopbackHosts, value.hostname),
        onSome: (origins) => Array.contains(origins, value.origin),
      })

      return matches && trusted
    })

    const untrusted = !trustedOrigin
    const rejectedRequestOrigin = Option.isSome(origin) && untrusted
    const rejectedOrigin = crossSite || rejectedRequestOrigin

    if (rejectedOrigin) return yield* failure(403, "Cross-origin or untrusted application UI requests are not allowed")

    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
      return yield* failure(415, "Application UI calls require application/json")
    }

    const body = yield* pipe(request.json, Effect.flatMap(Schema.decodeUnknownEffect(CallSchema)), Effect.result)

    if (Result.isFailure(body)) return yield* failure(400, "Invalid application UI call envelope")

    const invoke = HashMap.get(invocations, body.success.operation)

    if (Option.isNone(invoke)) return yield* failure(400, "Unknown operation")

    return yield* invoke.value(body.success.input, request)
  }, Effect.catchDefect(internalFailure))

  yield* router.add("POST", callPath, receive)
})

const layerHttp = <App extends ApplicationIR>(options: Readonly<{
  application: App
  javascript: string
  stylesheet: string
// SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
}> & Readonly<Partial<{ telemetry: TelemetryOptions }>> & ApplicationUiOptions) => pipe(
  register(options),
  Layer.effectDiscard,
) as Layer.Layer<
  never,
  ApplicationUiDefinitionError,
  | HttpRouter.HttpRouter
  | Rpc.ToHandler<RpcGroup.Rpcs<App["group"]>>
  | Rpc.Middleware<RpcGroup.Rpcs<App["group"]>>
  | Rpc.MiddlewareClient<RpcGroup.Rpcs<App["group"]>>
  | Rpc.ServicesServer<RpcGroup.Rpcs<App["group"]>>
>

export const ApplicationUi = { layerHttp }
