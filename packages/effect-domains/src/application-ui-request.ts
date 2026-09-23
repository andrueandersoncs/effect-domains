import { Array, Effect, Equivalence, FileSystem, Function, HashMap, HashSet, Option, Schema } from "effect"
import { HttpServerRequest, type HttpServerResponse } from "effect/unstable/http"
import { applicationUiFailureResponse, applicationUiInternalResponse } from "./application-ui-response.ts"

const CallSchema = Schema.Struct({ operation: Schema.String, input: Schema.Json })
const maximumCallBytes = FileSystem.KiB(64)
const loopbackHosts = HashSet.make("localhost", "127.0.0.1", "[::1]")

type RequestErrorStatus = 400 | 403 | 415

const RequestErrorStatusSchema = Schema.Literals([400, 403, 415])

class ApplicationUiRequestError extends Schema.TaggedError<ApplicationUiRequestError>()(
  "ApplicationUiRequestError",
  { status: RequestErrorStatusSchema, reason: Schema.String },
) {}

export type Invocation = (
  input: unknown,
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<HttpServerResponse.HttpServerResponse>

const trustedRequestOrigin = (
  request: HttpServerRequest.HttpServerRequest,
  allowedOrigins: Option.Option<ReadonlyArray<string>>,
) => {
  const origin = Option.fromNullishOr(request.headers.origin)
  const url = HttpServerRequest.toURL(request)

  const trusted = Option.exists(url, (value) => {
    const sameOrigin = Option.contains(origin, value.origin)

    const trustedHost = Option.match(allowedOrigins, {
      onNone: () => HashSet.has(loopbackHosts, value.hostname),
      onSome: (origins) => Array.contains(origins, value.origin),
    })

    return sameOrigin && trustedHost
  })

  return Option.isNone(origin) || trusted
}

const validateRequestHeaders = Effect.fn("ApplicationUi.validateRequestHeaders")(function* (
  allowedOrigins: Option.Option<ReadonlyArray<string>>,
  request: HttpServerRequest.HttpServerRequest,
) {

  const crossSite = Equivalence.strictEqual<string | undefined>()(
    request.headers["sec-fetch-site"],
    "cross-site",
  )

  const trustedOrigin = trustedRequestOrigin(request, allowedOrigins)
  const untrustedOrigin = !trustedOrigin
  const rejectedOrigin = crossSite || untrustedOrigin

  if (rejectedOrigin) {
    return yield* ApplicationUiRequestError.make({
      status: 403,
      reason: "Cross-origin or untrusted application UI requests are not allowed",
    })
  }

  const contentType = request.headers["content-type"] ?? ""
  const supportedContentType = /^application\/json(?:\s*;|$)/i.test(contentType)

  if (!supportedContentType) {
    return yield* ApplicationUiRequestError.make({
      status: 415,
      reason: "Application UI calls require application/json",
    })
  }

})

const requestBody = Effect.fn("ApplicationUi.requestBody")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {

  const boundedBody = Effect.provideService(
    request.json,
    HttpServerRequest.MaxBodySize,
    maximumCallBytes,
  )

  const decodeBody = Schema.decodeUnknownEffect(CallSchema)
  const parsedBody = Effect.flatMap(boundedBody, decodeBody)

  const invalidEnvelope = () => ApplicationUiRequestError.make({
    status: 400,
    reason: "Invalid application UI call envelope",
  })


  return yield* Effect.mapError(parsedBody, invalidEnvelope)
})

const configuredInvocation = Effect.fn("ApplicationUi.configuredInvocation")(function* (
  invocations: HashMap.HashMap<string, Invocation>,
  operation: string,
) {
  const configured = HashMap.get(invocations, operation)

  const unknownOperation = () => ApplicationUiRequestError.make({
    status: 400,
    reason: "Unknown operation",
  })

  return yield* Effect.fromOption(configured, unknownOperation)
})

const decodedCall = Effect.fn("ApplicationUi.decodedCall")(function* (
  invocations: HashMap.HashMap<string, Invocation>,
  allowedOrigins: Option.Option<ReadonlyArray<string>>,
  request: HttpServerRequest.HttpServerRequest,
) {
  yield* validateRequestHeaders(allowedOrigins, request)

  const body = yield* requestBody(request)
  const invocation = yield* configuredInvocation(invocations, body.operation)

  return { invocation, input: body.input }
})

const requestFailure = Effect.fn("ApplicationUi.requestFailure")(function* (
  error: ApplicationUiRequestError,
) {
  return yield* applicationUiFailureResponse(error.status, error.reason)
})

const internalResponse = Effect.succeed(applicationUiInternalResponse)
const internalFailure = Function.constant(internalResponse)


const receive = Effect.fn("ApplicationUi.receive")(function* (
  invocations: HashMap.HashMap<string, Invocation>,
  allowedOrigins: Option.Option<ReadonlyArray<string>>,
  request: HttpServerRequest.HttpServerRequest,
) {
  const call = yield* decodedCall(invocations, allowedOrigins, request)

  return yield* call.invocation(call.input, request)
},
Effect.catchTag("ApplicationUiRequestError", requestFailure),
Effect.catchTag("HttpBodyError", internalFailure),
Effect.catchDefect(internalFailure))


export const requestHandlerFor = (
  invocations: HashMap.HashMap<string, Invocation>,
  allowedOrigins: Option.Option<ReadonlyArray<string>>,
) => Effect.fn("ApplicationUi.requestHandler")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  return yield* receive(invocations, allowedOrigins, request)
})
