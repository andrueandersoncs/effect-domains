import { Array, type Duration, Effect, Equal, FiberSet, Function, Option, Predicate, Record, Ref, Schema, String, flow, pipe } from "effect"
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest, HttpMethod } from "effect/unstable/http"
import { AcceptanceError, type FixtureRuntime, PayloadSchema, type PreparedFixture, ProbeTarget, type Payload } from "./model.ts"
import type { CallResponse, call } from "./server.ts"

const loopback = "127.0.0.1"

const callPath = "/api/call"

/** The injected control is served from the proxied origin because the application's CSP only admits same-origin scripts. */
const controlPath = "/__acceptance-fault/control.js"

const controlTag = `<script src="${controlPath}"></script>`

const bodyClose = "</body>"

// Hop-by-hop and length headers are dropped because the transport recomputes them; replies drop their encoding header because fetch decodes compressed bodies.
const forwardedRequestHeaders = ["host", "connection", "keep-alive", "content-length", "transfer-encoding"]

const returnedResponseHeaders = ["connection", "keep-alive", "content-length", "transfer-encoding", "content-encoding"]

const bodilessStatuses = [101, 204, 205, 304]

const HeadersSchema = Schema.Record(Schema.String, Schema.String)

/** A public application call as the generated UI posts it to /api/call. */
export class ProxyCall extends Schema.Class<ProxyCall>("ProxyCall")({
  operation: Schema.String,
  input: PayloadSchema,
}) {}

/** The response text is kept verbatim because unaffected replies must reach the browser byte-for-byte. */
export class ProxyResponse extends Schema.Class<ProxyResponse>("ProxyResponse")({
  status: Schema.Int,
  headers: HeadersSchema,
  text: Schema.String,
}) {}

const OptionalValueSchema = Schema.OptionFromOptionalKey(Schema.Unknown)

/** The /api/call envelope carries exactly one of result or error. */
export class Reply extends Schema.Class<Reply>("Reply")({
  result: OptionalValueSchema,
  error: OptionalValueSchema,
}) {}

const ProxyCallJsonSchema = Schema.fromJsonString(ProxyCall)

const ReplyJsonSchema = Schema.fromJsonString(Reply)

export type Forward = (request: ProxyCall) => Effect.Effect<ProxyResponse, AcceptanceError>

/** A fault behavior decides every public call and may inject a script into each document load. */
export interface FaultBehavior {
  readonly call: (request: ProxyCall, forward: Forward) => Effect.Effect<ProxyResponse, AcceptanceError>
  readonly document: Effect.Effect<Option.Option<string>, AcceptanceError>
}

/** Behaviors see the owned upstream and the fixture runtime because their extra real calls and probes must observe true state. */
export interface FaultContext {
  readonly fixture: PreparedFixture
  readonly upstream: string
  readonly runtime: FixtureRuntime["Service"]
  readonly call: typeof call
  readonly record: (injection: string) => Effect.Effect<void>
}

export const FaultKindSchema = Schema.Literals(["defective-implementation", "execution-control"])

const AffectedSchema = Schema.Array(Schema.NonEmptyString)
const OverrideSchema = Schema.OptionFromOptionalKey(Schema.Int)

/** A labeled fault because every defective implementation and control must be identifiable in retained evidence. */
export class FaultDeclaration extends Schema.Class<FaultDeclaration>("FaultDeclaration")({
  id: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  kind: FaultKindSchema,
  scenario: Schema.NonEmptyString,
  affected: AffectedSchema,
  deadlineSeconds: OverrideSchema,
  maxActions: OverrideSchema,
}) {}

/** The behavior is an application-owned factory because only the application knows how its defect is shaped. */
export interface Fault {
  readonly declaration: FaultDeclaration
  readonly behavior: (context: FaultContext) => Effect.Effect<FaultBehavior, AcceptanceError>
}

const proxyError = (message: string) => AcceptanceError.make({ boundary: "fault-proxy", message })

const describeProxyFailure = flow(globalThis.String, proxyError)

const decodeReplyText = Schema.decodeUnknownEffect(ReplyJsonSchema)

const encodeReplyText = Schema.encodeEffect(ReplyJsonSchema)

const encodeCallText = Schema.encodeEffect(ProxyCallJsonSchema)

const decodeCallText = Schema.decodeUnknownOption(ProxyCallJsonSchema)

/** Decodes the envelope of a forwarded or answered call. */
export const replyOf = Effect.fn("Acceptance.faults.replyOf")(function* (response: ProxyResponse) {
  return yield* pipe(response.text, decodeReplyText, Effect.mapError(describeProxyFailure))
})

const jsonHeaders = HeadersSchema.make({ "content-type": "application/json" })

/** Answers a call without the application, as a defective implementation would. */
export const answer = Effect.fn("Acceptance.faults.answer")(function* (status: number, reply: Reply) {
  const text = yield* pipe(reply, encodeReplyText, Effect.mapError(describeProxyFailure))

  return ProxyResponse.make({ status, headers: jsonHeaders, text })
})

/** Replaces the envelope of a forwarded reply while keeping its status and headers. */
export const rewrite = Effect.fn("Acceptance.faults.rewrite")(function* (response: ProxyResponse, reply: Reply) {
  const text = yield* pipe(reply, encodeReplyText, Effect.mapError(describeProxyFailure))

  return ProxyResponse.make({ status: response.status, headers: response.headers, text })
})

const forwardUnchanged = Effect.fn("Acceptance.faults.forwardUnchanged")(function* (request: ProxyCall, forward: Forward) {
  return yield* forward(request)
})

const behaviorOf = (call: FaultBehavior["call"], document: FaultBehavior["document"]): FaultBehavior => ({ call, document })

/** Forwards everything unchanged; the base of every narrower behavior. */
export const transparent = behaviorOf(forwardUnchanged, Effect.succeedNone)

const delayedForward = (context: FaultContext, delay: Duration.Input) => Effect.fn("Acceptance.faults.delayedForward")(function* (request: ProxyCall, forward: Forward) {
  yield* context.record(`delayed ${request.operation}`)
  yield* Effect.sleep(delay)

  return yield* forward(request)
})

/** Delays every public call because deadline controls must expire on real, slow application traffic. */
export const delayedCalls = (delay: Duration.Input) => Effect.fn("Acceptance.faults.delayedCalls")(function* (context: FaultContext) {
  const call = delayedForward(context, delay)
  const behavior = behaviorOf(call, Effect.succeedNone)

  return yield* Effect.succeed(behavior)
})

const injectedDocument = (context: FaultContext, name: string, script: string) => {
  const injection = context.record(`injected ${name} control script`)
  const injected = Option.some(script)

  return Effect.as(injection, injected)
}

/** Injects a named script into every document load because UI controls act inside the real generated interface. */
export const scripted = (name: string, script: string) => Effect.fn("Acceptance.faults.scripted")(function* (context: FaultContext) {
  const document = injectedDocument(context, name, script)
  const behavior = behaviorOf(forwardUnchanged, document)

  return yield* Effect.succeed(behavior)
})

const anonymous = Option.none<never>()

const describedStatus = (operation: string) => (response: CallResponse) => `extra real call ${operation} answered HTTP ${response.status}`

/** Performs an extra real call against the owned application because some defects mutate state the request never asked for. */
export const realCall = Effect.fn("Acceptance.faults.realCall")(function* (context: FaultContext, operation: string, input: Payload) {
  const response = yield* context.call(context.upstream, operation, input, anonymous)
  const description = describedStatus(operation)(response)

  yield* context.record(description)

  return response
})

const missingFact = (fact: string) => proxyError(`The prepared fixture has no decodable fact ${fact}`)

/** Reads a prepared fixture fact because defects target the fixture's own sentinel and target records. */
export const fixtureFact = Effect.fn("Acceptance.faults.fixtureFact")(function* <A>(context: FaultContext, fact: string, schema: Schema.Decoder<A>) {
  const value = Record.get(context.fixture.facts, fact)
  const decoded = Option.flatMap(value, Schema.decodeUnknownOption(schema))
  const absent = missingFact(fact)

  return yield* pipe(decoded, Effect.fromOption, Effect.mapError(Function.constant(absent)))
})

/** Reads hidden state through the fixture's own probe because a leaking defect must return the application's true records. */
export const fixtureProbe = Effect.fn("Acceptance.faults.fixtureProbe")(function* (context: FaultContext, probe: string, subject: string) {
  const target = ProbeTarget.make({ probe, phase: "fault", subject })
  const record = yield* context.runtime.probe(context.fixture, target)

  yield* context.record(`fixture probe ${probe} for ${subject} answered HTTP ${record.status}`)

  return record
})

// The scripts are plain text because they run in the page, not in this process; they only touch the generated form's submit button.
/** Mutates the active form's submit button attributes every 250 ms so offered snapshots go stale. */
export const racingSubmitScript = `(() => {
  let tick = 0
  const race = () => {
    tick += 1
    document.querySelectorAll("form.admin-form button[data-action='submit']").forEach((button) => {
      button.setAttribute("data-acceptance-race", String(tick))
      button.setAttribute("aria-disabled", tick % 2 === 0 ? "true" : "false")
      button.toggleAttribute("hidden", tick % 4 === 3)
    })
  }
  setInterval(race, 250)
})()
`

/** Keeps every generated submit button disabled. */
export const disabledSubmitScript = `(() => {
  const disable = () => {
    document.querySelectorAll("form.admin-form button[data-action='submit']").forEach((button) => {
      if (!button.disabled) button.disabled = true
    })
  }
  new MutationObserver(disable).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled"] })
  setInterval(disable, 50)
  disable()
})()
`

const plainHeaders = (headers: Headers.Headers) => HeadersSchema.make(Record.filter(headers, Predicate.isString))

const responseHeaders = flow(Headers.removeMany(returnedResponseHeaders), plainHeaders)

const upstreamUrl = (upstream: string, request: Request) => {
  const incoming = new URL(request.url)

  return `${upstream}${incoming.pathname}${incoming.search}`
}

const unsupportedText = (method: string) => `Unsupported HTTP method ${method}`

const unsupportedMethod = flow(unsupportedText, proxyError, Function.constant)

const methodOf = (method: string) => pipe(method, Option.liftPredicate(HttpMethod.isHttpMethod), Effect.fromOption, Effect.mapError(unsupportedMethod(method)))

const isBodiless = (method: string) => Array.contains(["GET", "HEAD"], method)

class Incoming extends Schema.Class<Incoming>("Incoming")({
  method: Schema.String,
  url: Schema.String,
  headers: HeadersSchema,
  contentType: Schema.String,
}) {}

class Upstream extends Schema.Class<Upstream>("Upstream")({
  status: Schema.Int,
  headers: HeadersSchema,
  body: Schema.Uint8Array,
}) {}

const send = Effect.fn("Acceptance.faults.send")(function* (incoming: Incoming, body: Uint8Array) {
  const client = yield* HttpClient.HttpClient
  const method = yield* methodOf(incoming.method)
  const base = HttpClientRequest.make(method)(incoming.url, { headers: incoming.headers })
  const request = isBodiless(incoming.method) ? base : HttpClientRequest.bodyUint8Array(base, body, incoming.contentType)
  const response = yield* pipe(client.execute(request), Effect.mapError(describeProxyFailure))
  const buffer = yield* pipe(response.arrayBuffer, Effect.mapError(describeProxyFailure))
  const bytes = new Uint8Array(buffer)
  const headers = responseHeaders(response.headers)

  return Upstream.make({ status: response.status, headers, body: bytes })
}, Effect.provide(FetchHttpClient.layer))

const textEncoder = new TextEncoder()

const textDecoder = new TextDecoder()

const encodeCall = Effect.fn("Acceptance.faults.encodeCall")(function* (request: ProxyCall) {
  const text = yield* pipe(request, encodeCallText, Effect.mapError(describeProxyFailure))

  return textEncoder.encode(text)
})

// An unchanged call is sent with its original bytes because the browser's exact request must reach the application byte-for-byte.
const forwardCall = (incoming: Incoming, original: ProxyCall, bytes: Uint8Array) => Effect.fn("Acceptance.faults.forward")(function* (request: ProxyCall) {
  const unchanged = Equal.equals(request, original)
  const body = unchanged ? bytes : yield* encodeCall(request)
  const upstream = yield* send(incoming, body)
  const reply = textDecoder.decode(upstream.body)

  return ProxyResponse.make({ status: upstream.status, headers: upstream.headers, text: reply })
})

const webResponse = (status: number, headers: Readonly<Record<string, string>>, body: BodyInit) => {
  const bodiless = Array.contains(bodilessStatuses, status)
  const content = bodiless ? null : body
  const init: ResponseInit = { status, headers }

  return new globalThis.Response(content, init)
}

const fromUpstream = (upstream: Upstream) => {
  const body = upstream.body.slice()

  return webResponse(upstream.status, upstream.headers, body)
}

const fromProxy = (response: ProxyResponse) => webResponse(response.status, response.headers, response.text)

const failureHeaders = HeadersSchema.make({ "content-type": "text/plain; charset=utf-8" })

const isHtml = (headers: Readonly<Record<string, string>>) => pipe(headers, Record.get("content-type"), Option.exists(String.includes("text/html")))

const withControl = String.replace(bodyClose, `${controlTag}${bodyClose}`)

const decodeText = (bytes: Uint8Array) => textDecoder.decode(bytes)

const OptionalScriptSchema = Schema.Option(Schema.String)

class ProxyState extends Schema.Class<ProxyState>("ProxyState")({
  script: OptionalScriptSchema,
}) {}

const scriptHeaders = HeadersSchema.make({ "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" })

const isDocumentRequest = (request: Request) => {
  const destination = request.headers.get("sec-fetch-dest")
  const get = Equal.equals(request.method, "GET")
  const navigated = Equal.equals(destination, "document")

  return get && navigated
}

/** The proxy URL is all a browser needs because the proxy owns its port and forwards to the owned application. */
class FaultProxy extends Schema.Class<FaultProxy>("FaultProxy")({
  url: Schema.String,
}) {}

const choose = Effect.fn("Acceptance.faults.choose")(function* (behavior: FaultBehavior, incoming: Incoming, body: Uint8Array) {
  const text = textDecoder.decode(body)
  const decoded = decodeCallText(text)

  if (Option.isNone(decoded)) {
    const upstream = yield* send(incoming, body)

    return fromUpstream(upstream)
  }

  const forward = forwardCall(incoming, decoded.value, body)
  const response = yield* behavior.call(decoded.value, forward)

  return fromProxy(response)
})

const stopServer = <Data>(server: Bun.Server<Data>) => Effect.promise(() => server.stop(true))

/**
 * Serves a scoped fault proxy in front of an owned application because defects must reach the real browser
 * without any production fault switch. Unaffected traffic is forwarded byte-for-byte; release stops the server.
 */
export const serveFaultProxy = Effect.fn("Acceptance.faults.serve")(function* (upstream: string, behavior: FaultBehavior) {
  const initial = ProxyState.make({ script: Option.none() })
  const state = yield* Ref.make(initial)
  const fibers = yield* FiberSet.make<globalThis.Response>()
  const run = yield* FiberSet.runtimePromise(fibers)()
  const failed = (error: AcceptanceError) => webResponse(502, failureHeaders, `Fault proxy failure: ${error.message}`)

  const documentLoad = Effect.fn("Acceptance.faults.document")(function* (incoming: Incoming) {
    const injected = yield* behavior.document
    const empty = new Uint8Array()
    const upstreamDocument = yield* send(incoming, empty)
    const html = isHtml(upstreamDocument.headers)
    const injecting = Option.filter(injected, Function.constant(html))

    if (Option.isNone(injecting)) return fromUpstream(upstreamDocument)

    const loaded = ProxyState.make({ script: injecting })

    yield* Ref.set(state, loaded)

    const page = pipe(upstreamDocument.body, decodeText, withControl)

    return webResponse(upstreamDocument.status, upstreamDocument.headers, page)
  })

  const control = Effect.fn("Acceptance.faults.control")(function* () {
    const current = yield* Ref.get(state)

    return Option.match(current.script, {
      onNone: () => webResponse(404, failureHeaders, "No fault control script"),
      onSome: (script) => webResponse(200, scriptHeaders, script),
    })
  })

  const handle = Effect.fn("Acceptance.faults.handle")(function* (request: Request) {
    const address = new URL(request.url)
    const url = upstreamUrl(upstream, request)
    const received = yield* Effect.tryPromise({ try: () => request.arrayBuffer(), catch: describeProxyFailure })
    const body = new Uint8Array(received)
    const forwarded = pipe(Headers.fromInput(request.headers), Headers.removeMany(forwardedRequestHeaders), plainHeaders)
    const host = HeadersSchema.make({ host: address.host })
    const headers = HeadersSchema.make({ ...forwarded, ...host })
    const contentType = pipe(request.headers.get("content-type"), Option.fromNullOr, Option.getOrElse(Function.constant("application/octet-stream")))
    const document = isDocumentRequest(request)
    const incoming = Incoming.make({ method: request.method, url, headers, contentType })
    const controlRequest = Equal.equals(address.pathname, controlPath)
    const posted = Equal.equals(request.method, "POST")
    const calling = Equal.equals(address.pathname, callPath)
    const publicCall = posted && calling

    if (controlRequest) return yield* control()

    if (document) return yield* documentLoad(incoming)

    if (publicCall) return yield* choose(behavior, incoming, body)

    const upstreamResponse = yield* send(incoming, body)

    return fromUpstream(upstreamResponse)
  })

  const respond = (request: Request) => pipe(handle(request), Effect.catch(flow(failed, Effect.succeed)), run)
  const options: Bun.Serve.Options<undefined> = { hostname: loopback, port: 0, idleTimeout: 60, fetch: respond }
  const started = Effect.try({ try: () => Bun.serve(options), catch: describeProxyFailure })
  const server = yield* Effect.acquireRelease(started, stopServer)
  const portless = pipe("Fault proxy has no port", proxyError, Function.constant)
  const port = yield* pipe(server.port, Option.fromNullishOr, Option.filter(Predicate.isNumber), Effect.fromOption, Effect.mapError(portless))

  return FaultProxy.make({ url: `http://${loopback}:${port}` })
})
