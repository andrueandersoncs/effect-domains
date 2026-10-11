import { expect, it } from "@effect/vitest"
import { Array, Duration, Effect, Equivalence, Function, Option, Ref, Schema, Tuple, flow, pipe } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { type FaultBehavior, type FaultContext, type Forward, ProxyCall, ProxyResponse, Reply, answer, delayedCalls, fixtureFact, fixtureProbe, realCall, replyOf, scripted, serveFaultProxy, transparent } from "./faults.ts"
import { AcceptanceError, FixtureRuntime, PayloadSchema, PreparedFixture, ProbeRecord, type ProbeTarget } from "./model.ts"
import { call } from "./server.ts"

/** What the owned upstream received, echoed back so tests can assert exactly what the proxy forwarded. */
class Received extends Schema.Class<Received>("Received")({
  method: Schema.String,
  path: Schema.String,
  search: Schema.String,
  host: Schema.String,
  marker: Schema.String,
  body: Schema.String,
}) {}

const ReceivedJsonSchema = Schema.fromJsonString(Received)

const page = "<!doctype html><html><head><title>Owned</title></head><body><div id=\"app\"></div></body></html>"

const injectedPage = "<!doctype html><html><head><title>Owned</title></head><body><div id=\"app\"></div><script src=\"/__acceptance-fault/control.js\"></script></body></html>"

// The upstream answers /api/call with deliberately unusual JSON spacing because forwarding must be byte-for-byte.
const upstreamReply = (body: string) => `{ "result" :  ${body} }`

const header = (request: Request, name: string) => pipe(request.headers.get(name), Option.fromNullOr, Option.getOrElse(Function.constant("")))

const json = { "content-type": "application/json", "x-upstream": "kept" }

const html = { "content-type": "text/html" }

const echo = Effect.fn("FaultsTest.echo")(function* (request: Request) {
  const url = new URL(request.url)
  const body = yield* Effect.promise(() => request.text())
  const received = Received.make({ method: request.method, path: url.pathname, search: url.search, host: header(request, "host"), marker: header(request, "x-marker"), body })
  const text = yield* Schema.encodeEffect(ReceivedJsonSchema)(received)
  const calling = Equivalence.strictEqual<string>()(url.pathname, "/api/call")
  const document = Equivalence.strictEqual<string>()(url.pathname, "/")
  const reply = upstreamReply(text)

  if (calling) return new Response(reply, { headers: json })

  return document ? new Response(page, { headers: html }) : new Response(text, { status: 201, headers: json })
})

const upstreamOptions: Bun.Serve.Options<undefined> = { hostname: "127.0.0.1", port: 0, fetch: flow(echo, Effect.runPromise) }

const serveUpstream = () => Bun.serve(upstreamOptions)

const stopUpstream = <Data>(server: Bun.Server<Data>) => Effect.promise(() => server.stop(true))

const started = Effect.sync(serveUpstream)

const upstreamUrl = Effect.gen(function* () {
  const server = yield* Effect.acquireRelease(started, stopUpstream)

  return `http://127.0.0.1:${server.port}`
})

class Answered extends Schema.Class<Answered>("Answered")({
  status: Schema.Int,
  contentType: Schema.String,
  upstreamHeader: Schema.String,
  text: Schema.String,
}) {}

const asTestFailure = (cause: unknown) => AcceptanceError.make({ boundary: "test", message: String(cause) })

const execute = Effect.fn("FaultsTest.execute")(function* (request: HttpClientRequest.HttpClientRequest) {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.execute(request)
  const text = yield* response.text
  const contentType = pipe(response.headers["content-type"], Option.fromUndefinedOr, Option.getOrElse(Function.constant("")))
  const upstreamHeader = pipe(response.headers["x-upstream"], Option.fromUndefinedOr, Option.getOrElse(Function.constant("")))

  return Answered.make({ status: response.status, contentType, upstreamHeader, text })
}, Effect.mapError(asTestFailure), Effect.provide(FetchHttpClient.layer))

const decodeReceived = Schema.decodeUnknownEffect(ReceivedJsonSchema)

// The forwarded call is hand-spaced because an unchanged call must reach the application with its exact original bytes.
const listCall = "{\"operation\" : \"books.list\",\n  \"input\": {\"limit\":2}}"

const updateCall = JSON.stringify({ operation: "books.update", input: { id: "target", rating: 5 } })

const forwardingTest = Effect.gen(function* () {
  const upstream = yield* upstreamUrl
  const proxy = yield* serveFaultProxy(upstream, transparent)
  const { host } = new URL(proxy.url)
  const raw = pipe(HttpClientRequest.post(`${proxy.url}/resource/item?q=1&r=two`), HttpClientRequest.setHeader("x-marker", "m1"), HttpClientRequest.bodyText("raw body", "text/plain"))
  const response = yield* execute(raw)
  const received = yield* decodeReceived(response.text)
  const expected = Received.make({ method: "POST", path: "/resource/item", search: "?q=1&r=two", host, marker: "m1", body: "raw body" })

  expect(response.status).toBe(201)
  expect(response.upstreamHeader).toBe("kept")
  expect(received).toEqual(expected)

  const call = pipe(HttpClientRequest.post(`${proxy.url}/api/call`), HttpClientRequest.bodyText(listCall, "application/json"))
  const forwarded = yield* execute(call)
  const echoed = Received.make({ method: "POST", path: "/api/call", search: "", host, marker: "", body: listCall })
  const echoedText = yield* Schema.encodeEffect(ReceivedJsonSchema)(echoed)
  const verbatim = upstreamReply(echoedText)

  expect(forwarded.text).toBe(verbatim)
  expect(forwarded.upstreamHeader).toBe("kept")
})

const RewrittenSchema = Schema.Struct({ result: Received })

interface Rewritten extends Schema.Schema.Type<typeof RewrittenSchema> {}

const RewrittenJsonSchema = Schema.fromJsonString(RewrittenSchema)

const rewriteInput = Effect.fn("FaultsTest.rewriteInput")(function* (request: ProxyCall, forward: Forward) {
  const input = PayloadSchema.make({ ...request.input, id: "sentinel" })
  const rewritten = ProxyCall.make({ operation: request.operation, input })

  return yield* forward(rewritten)
})

const answerLocally = Effect.fn("FaultsTest.answerLocally")(function* (request: ProxyCall) {
  const result = Option.some({ fabricated: request.operation })
  const reply = Reply.make({ result, error: Option.none() })

  return yield* answer(200, reply)
})

const rewriting: FaultBehavior = { call: rewriteInput, document: Effect.succeedNone }

const answering: FaultBehavior = { call: answerLocally, document: Effect.succeedNone }

const sentUpdate = JSON.stringify({ operation: "books.update", input: { id: "sentinel", rating: 5 } })

const rewritingTest = Effect.gen(function* () {
  const upstream = yield* upstreamUrl
  const proxy = yield* serveFaultProxy(upstream, rewriting)
  const request = pipe(HttpClientRequest.post(`${proxy.url}/api/call`), HttpClientRequest.bodyText(updateCall, "application/json"))
  const response = yield* execute(request)
  const decoded: Rewritten = yield* Schema.decodeUnknownEffect(RewrittenJsonSchema)(response.text)

  expect(decoded.result.body).toBe(sentUpdate)

  const local = yield* serveFaultProxy(upstream, answering)
  const localRequest = pipe(HttpClientRequest.post(`${local.url}/api/call`), HttpClientRequest.bodyText(updateCall, "application/json"))
  const answered = yield* execute(localRequest)
  const retained = ProxyResponse.make({ status: answered.status, headers: {}, text: answered.text })
  const reply = yield* replyOf(retained)

  expect(answered.status).toBe(200)
  expect(answered.upstreamHeader).toBe("")

  const fabricated = Option.some({ fabricated: "books.update" })

  expect(reply.result).toEqual(fabricated)
})

const controlScript = "window.injected = true"

const unusedRuntimeOperation = () => Effect.die("unused by this fault context")

const probedRecord = (fixture: PreparedFixture, target: ProbeTarget) => ProbeRecord.make({
  probe: target.probe,
  phase: target.phase,
  subject: target.subject,
  actor: fixture.actor,
  at: "2026-10-10T00:00:00.000Z",
  status: 200,
  result: Option.some(["recorded"]),
  error: Option.none(),
})

const probeRuntime = flow(probedRecord, Effect.succeed)

// The runtime answers only probes because the helpers under test use nothing else from the fixture.
const runtime = FixtureRuntime.of({
  revision: "faults-test",
  bindings: [],
  actors: [],
  facts: [],
  probes: [],
  prepare: unusedRuntimeOperation,
  probe: probeRuntime,
  direct: unusedRuntimeOperation,
  session: unusedRuntimeOperation,
  secrets: unusedRuntimeOperation,
})

const contextFor = Effect.fn("FaultsTest.context")(function* (upstream: string) {
  const injections = yield* Ref.make<ReadonlyArray<string>>([])
  const fixture = PreparedFixture.make({ binding: "test", revision: "faults-test", url: upstream, actor: "tester", facts: { "sentinel.id": "sentinel-1" }, tracked: [] })
  const record = (injection: string) => Ref.update(injections, Array.append(injection))
  const context: FaultContext = { fixture, upstream, runtime, call, record }

  return Tuple.make(context, injections)
})

const injectionTest = Effect.gen(function* () {
  const upstream = yield* upstreamUrl
  const [context, injections] = yield* contextFor(upstream)
  const behavior = yield* scripted("probe", controlScript)(context)
  const proxy = yield* serveFaultProxy(upstream, behavior)
  const document = pipe(HttpClientRequest.get(`${proxy.url}/`), HttpClientRequest.setHeader("sec-fetch-dest", "document"))
  const loaded = yield* execute(document)
  const scriptRequest = HttpClientRequest.get(`${proxy.url}/__acceptance-fault/control.js`)
  const script = yield* execute(scriptRequest)
  const assetRequest = HttpClientRequest.get(`${proxy.url}/`)
  const asset = yield* execute(assetRequest)
  const recorded = yield* Ref.get(injections)

  expect(loaded.text).toBe(injectedPage)
  expect(script.text).toBe(controlScript)
  expect(script.contentType).toContain("text/javascript")
  expect(asset.text).toBe(page)
  expect(recorded).toEqual(["injected probe control script"])
})

const delayTest = Effect.gen(function* () {
  const upstream = yield* upstreamUrl
  const [context, injections] = yield* contextFor(upstream)
  const behavior = yield* delayedCalls("300 millis")(context)
  const proxy = yield* serveFaultProxy(upstream, behavior)
  const request = pipe(HttpClientRequest.post(`${proxy.url}/api/call`), HttpClientRequest.bodyText(listCall, "application/json"))
  const executing = execute(request)
  const [elapsed, response] = yield* Effect.timed(executing)
  const recorded = yield* Ref.get(injections)
  const millis = Duration.toMillis(elapsed)

  expect(millis).toBeGreaterThanOrEqual(300)
  expect(response.status).toBe(200)
  expect(recorded).toEqual(["delayed books.list"])
})

const helperTest = Effect.gen(function* () {
  const upstream = yield* upstreamUrl
  const [context, injections] = yield* contextFor(upstream)
  const input = PayloadSchema.make({ id: "sentinel-1", notes: "mutated" })
  const response = yield* realCall(context, "books.update", input)
  const sentinel = yield* fixtureFact(context, "sentinel.id", Schema.String)
  const missing = yield* pipe(fixtureFact(context, "target.id", Schema.String), Effect.flip)
  const probed = yield* fixtureProbe(context, "audit-trail", "case-1")
  const recorded = yield* Ref.get(injections)
  const probedResult = Option.some(["recorded"])

  expect(response.status).toBe(200)
  expect(sentinel).toBe("sentinel-1")
  expect(missing.message).toBe("The prepared fixture has no decodable fact target.id")
  expect(probed.result).toEqual(probedResult)
  expect(probed.phase).toBe("fault")
  expect(recorded).toEqual(["extra real call books.update answered HTTP 200", "fixture probe audit-trail for case-1 answered HTTP 200"])
})

const releaseTest = Effect.gen(function* () {
  const upstream = yield* upstreamUrl
  const proxy = yield* pipe(serveFaultProxy(upstream, transparent), Effect.scoped)
  const afterRelease = HttpClientRequest.get(`${proxy.url}/after-release`)
  const failure = yield* pipe(execute(afterRelease), Effect.flip)

  expect(failure.boundary).toBe("test")
})

const scopedForwarding = Effect.scoped(forwardingTest)
const scopedRewriting = Effect.scoped(rewritingTest)
const scopedInjection = Effect.scoped(injectionTest)
const scopedDelay = Effect.scoped(delayTest)
const scopedHelpers = Effect.scoped(helperTest)
const scopedRelease = Effect.scoped(releaseTest)

it.live("the fault proxy forwards unaffected traffic byte-for-byte", Function.constant(scopedForwarding))
it.live("a fault behavior can rewrite a call before forwarding or answer it itself", Function.constant(scopedRewriting))
it.live("document loads receive the injected same-origin control script", Function.constant(scopedInjection))
it.live("a delayed-calls control records and delays every public call", Function.constant(scopedDelay))
it.live("extra real calls, fixture facts, and fixture probes are recorded against the owned upstream", Function.constant(scopedHelpers))
it.live("releasing the proxy scope stops the server", Function.constant(scopedRelease))
