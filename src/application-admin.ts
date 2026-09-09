import { Array, Effect, Equivalence, HashMap, HashSet, Layer, Option, Result, Schema, Struct, pipe } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { type Rpc, type RpcGroup, RpcSchema } from "effect/unstable/rpc"
import type { Application } from "./application.ts"
import { ApplicationInspect } from "./application-inspect.ts"
import { adminCss } from "./admin-style.ts"
import { makeClient, type UnaryRpc } from "./rpc-in-process.ts"

export type AdminPresentation = Readonly<Partial<{
  title: string
  resources: Readonly<Record<string, Readonly<Partial<{ label: string; columns: ReadonlyArray<string> }>>>>
  operations: Readonly<Record<string, Readonly<Partial<{ label: string; description: string }>>>>
}>>

export type AdminOptions = Readonly<Partial<{
  path: string
  presentation: AdminPresentation
  allowedOrigins: ReadonlyArray<string>
}>>

class AdminDefinitionError extends Schema.TaggedError<AdminDefinitionError>()("AdminDefinitionError", {
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
const sameString = Equivalence.strictEqual<string>()

const register = Effect.fn("ApplicationAdmin.register")(function* (options: Readonly<{
  application: Application
  javascript: string
}> & AdminOptions) {
  const path = (options.path ?? "/admin") as `/${string}`
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(path)) {
    return yield* AdminDefinitionError.make({ reason: "Admin path must contain nonempty URL path segments without a trailing slash" })
  }
  const router = yield* HttpRouter.HttpRouter
  const client = yield* makeClient(options.application.group as RpcGroup.RpcGroup<UnaryRpc>)
  const services = yield* Effect.context<Rpc.ServicesServer<UnaryRpc>>()
  const procedures = options.application.group.requests.values()

  const entries = yield* Effect.forEach(procedures, Effect.fn("ApplicationAdmin.compileOperation")(function* (procedure) {
    if (RpcSchema.isStreamSchema(procedure.successSchema)) {
      return yield* AdminDefinitionError.make({ reason: `Admin operations must be unary: ${procedure._tag}` })
    }
    const InputSchema = Schema.toCodecJson(procedure.payloadSchema)
    const OutputSchema = Schema.Struct({ result: Schema.toCodecJson(procedure.successSchema) })
    interface Output extends Schema.Schema.Type<typeof OutputSchema> {}
    const middlewareErrors = pipe(procedure.middlewares, Array.fromIterable, Array.map(Struct.get("error")))
    const ErrorSchema = Schema.Struct({ error: Schema.toCodecJson(Schema.Union([procedure.errorSchema, ...middlewareErrors])) })
    interface Error extends Schema.Schema.Type<typeof ErrorSchema> {}
    const decode = Schema.decodeUnknownEffect(InputSchema)
    const encodeResult = Schema.encodeUnknownEffect(OutputSchema)
    const encodeError = Schema.encodeUnknownEffect(ErrorSchema)

    const invoke = Effect.fn("ApplicationAdmin.invoke")(function* (input: unknown, request: HttpServerRequest.HttpServerRequest) {
      const decoded = yield* pipe(decode(input), Effect.result)
      if (Result.isFailure(decoded)) return yield* failure(400, `Invalid input for ${procedure._tag}: ${decoded.failure.message}`)
      return yield* pipe(
        client(procedure._tag, decoded.success, { headers: request.headers }),
        Effect.matchEffect({
          onFailure: (error) => pipe(encodeError({ error }), Effect.flatMap(declaredErrorResponse), Effect.catch(internalFailure)),
          onSuccess: (result) => pipe(encodeResult({ result }), Effect.flatMap(successResponse), Effect.catch(internalFailure)),
        }),
      )
    })

    const execute = (input: unknown, request: HttpServerRequest.HttpServerRequest) => pipe(
      invoke(input, request),
      Effect.provideContext(services),
      Effect.catchDefect(internalFailure),
    )

    return [procedure._tag, execute] as const
  }))

  const invocations = HashMap.fromIterable(entries)
  const metadata = pipe(ApplicationInspect.describe(options.application), Struct.assign({ presentation: options.presentation ?? {} }))

  const document = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Effect Domains Admin</title><link rel="stylesheet" href="${path}/style.css"><script type="module" src="${path}/client.js"></script></head><body><div id="app" data-base="${path}"></div><noscript>This application requires JavaScript.</noscript></body></html>`

  const html = pipe(HttpServerResponse.html(document), HttpServerResponse.setHeaders(responseHeaders))
  const javascript = HttpServerResponse.text(options.javascript, { contentType: "text/javascript", headers: responseHeaders })
  const stylesheet = HttpServerResponse.text(adminCss, { contentType: "text/css", headers: responseHeaders })
  const metadataResponse = successResponse(metadata)
  yield* router.add("GET", path, html)
  yield* router.add("GET", `${path}/client.js`, javascript)
  yield* router.add("GET", `${path}/style.css`, stylesheet)
  yield* router.add("GET", `${path}/api`, metadataResponse)

  const receive = Effect.fn("ApplicationAdmin.receive")(function* (request: HttpServerRequest.HttpServerRequest) {
    const origin = Option.fromNullishOr(request.headers.origin)
    const url = HttpServerRequest.toURL(request)
    const crossSite = sameString(request.headers["sec-fetch-site"] ?? "", "cross-site")
    const allowedOrigins = Option.fromNullishOr(options.allowedOrigins)

    const trustedOrigin = Option.exists(url, (value) => {
      const matches = Option.contains(origin, value.origin)
      const trusted = Option.match(allowedOrigins, {
        onNone: () => HashSet.has(loopbackHosts, value.hostname),
        onSome: (origins) => Array.contains(origins, value.origin),
      })
      return matches && trusted
    })

    const untrusted = Option.isSome(origin) && !trustedOrigin
    const rejectedOrigin = crossSite || untrusted
    if (rejectedOrigin) return yield* failure(403, "Cross-origin or untrusted admin requests are not allowed")
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
      return yield* failure(415, "Admin calls require application/json")
    }
    const body = yield* pipe(request.json, Effect.flatMap(Schema.decodeUnknownEffect(CallSchema)), Effect.result)
    if (Result.isFailure(body)) return yield* failure(400, "Invalid admin call envelope")
    const invoke = HashMap.get(invocations, body.success.operation)
    if (Option.isNone(invoke)) return yield* failure(400, "Unknown operation")
    return yield* invoke.value(body.success.input, request)
  }, Effect.catchDefect(internalFailure))

  yield* router.add("POST", `${path}/api/call`, receive)
})

const layerHttp = <App extends Application>(options: Readonly<{ application: App; javascript: string }> & AdminOptions) => pipe(
  register(options),
  Layer.effectDiscard,
) as Layer.Layer<
  never,
  AdminDefinitionError,
  | HttpRouter.HttpRouter
  | Rpc.ToHandler<RpcGroup.Rpcs<App["group"]>>
  | Rpc.Middleware<RpcGroup.Rpcs<App["group"]>>
  | Rpc.MiddlewareClient<RpcGroup.Rpcs<App["group"]>>
  | Rpc.ServicesServer<RpcGroup.Rpcs<App["group"]>>
>

export const ApplicationAdmin = { layerHttp }
