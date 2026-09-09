import { expect, it } from "@effect/vitest"
import { Array, Effect, Equivalence, Layer, Option, Schema, type Types, pipe } from "effect"
import { McpSchema } from "effect/unstable/ai"
import { HttpRouter } from "effect/unstable/http"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { ExampleAuthentication } from "@effect-domains/example-support/authentication"
import { StoragePrefix, StoredTextSchema } from "../apps/service-codec/storage.ts"
import { AuthorizationSubject } from "effect-domains/authorization"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { Commands } from "effect-domains/commands"
import { RpcMcp } from "effect-domains/rpc-mcp"


const send = Effect.fn("RpcMcp.testSend")(function* (
  handler: ReturnType<
    typeof HttpRouter.toWebHandler<never, never, HttpRouter.HttpRouter, never>
  >["handler"],
  headers: globalThis.Headers,
  message: Schema.JsonObject,
) {
  const body = JSON.stringify(message)
  const request = new Request("http://localhost/mcp", { method: "POST", headers, body })
  return yield* Effect.promise(() => handler(request))
})

const decode = Effect.fn("RpcMcp.testDecode")(function* <S extends Schema.Constraint>(response: Response, schema: S) {
  const text = yield* Effect.promise(() => response.text())
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text)
})

const openSession = Effect.fn("RpcMcp.testOpenSession")(function* (
  handler: ReturnType<
    typeof HttpRouter.toWebHandler<never, never, HttpRouter.HttpRouter, never>
  >["handler"],
) {
  const headers = new globalThis.Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" })

  const response = yield* send(handler, headers, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "regression", version: "1" } },
  })

  expect(response.status).toBe(200)
  const sessionId = yield* pipe(response.headers.get("mcp-session-id"), Option.fromNullishOr, Effect.fromOption)
  headers.set("mcp-session-id", sessionId)
  headers.set("mcp-protocol-version", "2025-11-25")
  yield* send(handler, headers, { jsonrpc: "2.0", method: "notifications/initialized" })
  return headers
})

const CallResponseSchema = Schema.Struct({ result: McpSchema.CallToolResult })
interface CallResponse extends Schema.Schema.Type<typeof CallResponseSchema> {}
const ListResponseSchema = Schema.Struct({ result: Schema.Struct({ tools: Schema.Array(McpSchema.Tool) }) })
interface ListResponse extends Schema.Schema.Type<typeof ListResponseSchema> {}

const call = Effect.fn("RpcMcp.testCall")(function* (
  handler: ReturnType<
    typeof HttpRouter.toWebHandler<never, never, HttpRouter.HttpRouter, never>
  >["handler"],
  headers: globalThis.Headers,
  id: number,
  name: string,
  input: Schema.Json,
) {
  const response = yield* send(handler, headers, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { input } } })
  return yield* decode(response, CallResponseSchema)
})

const makeServer = Effect.fn("RpcMcp.testMakeServer")(function* (routes: Layer.Layer<never, unknown, HttpRouter.HttpRouter>) {
  const server = HttpRouter.toWebHandler(routes, { disableLogger: true })
  yield* Effect.addFinalizer(() => Effect.promise(server.dispose))
  return server
})

class TimeUnavailable extends Schema.TaggedError<TimeUnavailable>()("TimeUnavailable", { at: Schema.Date }) {}
const time = Commands.rpc("clock.time", { payload: Schema.Date, success: Schema.Date, error: TimeUnavailable })
const StringListSchema = Schema.Array(Schema.String)
const list = Rpc.make("clock.list", { success: StringListSchema })
const clear = Rpc.make("clock.clear")
const broken = Rpc.make("clock.broken", { success: Schema.String })
const wire = Rpc.make("clock.wire", { payload: StoredTextSchema, success: StoredTextSchema })
const clock = RpcGroup.make(time, list, clear, broken, wire)
const rejectBefore = new Date("2026-01-01T00:00:00.000Z")

const clockHandlers = clock.toLayer({
  "clock.time": (at) => at < rejectBefore ? TimeUnavailable.make({ at }) : Effect.succeed(at),
  "clock.list": () => Effect.succeed(["one", "two"]),
  "clock.clear": () => Effect.void,
  "clock.broken": () => Effect.die("private database credential"),
  "clock.wire": (text) => Effect.succeed(`${text}!`),
})

const clockRoutes = pipe(RpcMcp.layerHttp({ name: "clock", group: clock, path: "/mcp" }), Layer.provide(clockHandlers))
const preservesCodecService = true satisfies Types.Equals<Layer.Services<typeof clockRoutes>, HttpRouter.HttpRouter | StoragePrefix>
void preservesCodecService

it.effect("MCP discovers codecs and preserves scalar, array, void, and declared error results", () => pipe(
  Effect.gen(function* () {
    const prefix = Layer.succeed(StoragePrefix, { value: "wire:" })
    const routes = Layer.provide(clockRoutes, prefix)
    const server = yield* makeServer(routes)
    const headers = yield* openSession(server.handler)
    const discovery = yield* send(server.handler, headers, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    const listed: ListResponse = yield* decode(discovery, ListResponseSchema)
    const isTime = (tool: McpSchema.Tool) => Equivalence.strictEqual<string>()(tool.name, "clock.time")
    const timeTool = yield* pipe(listed.result.tools, Array.findFirst(isTime), Effect.fromOption)
    expect(timeTool?.inputSchema.properties?.input).toMatchObject({ type: "string" })
    expect(timeTool?.outputSchema?.properties?.result).toMatchObject({ type: "string" })
    const at = "2026-02-03T04:05:06.000Z"
    const success: CallResponse = yield* call(server.handler, headers, 3, "clock.time", at)
    expect(success.result.structuredContent).toEqual({ result: at })
    expect(success.result.content).toEqual([{ type: "text", text: `{"result":"${at}"}` }])
    const array = yield* call(server.handler, headers, 4, "clock.list", null)
    expect(array.result.structuredContent).toEqual({ result: ["one", "two"] })
    const cleared = yield* call(server.handler, headers, 5, "clock.clear", null)
    expect(cleared.result.structuredContent).toEqual({ result: null })
    const rejected = yield* call(server.handler, headers, 6, "clock.time", "2025-01-01T00:00:00.000Z")
    expect(rejected.result.isError).toBe(true)
    expect(rejected.result.content).toEqual([{ type: "text", text: '{"_tag":"TimeUnavailable","at":"2025-01-01T00:00:00.000Z"}' }])
    const defect = yield* call(server.handler, headers, 7, "clock.broken", null)
    expect(defect.result.isError).toBe(true)
    const defectText = JSON.stringify(defect)
    const leaked = defectText.includes("private database credential")
    expect(leaked).toBe(false)

    const invalidResponse = yield* send(server.handler, headers, {
      jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "clock.time", arguments: { input: "not a date" } },
    })

    const invalid = yield* decode(invalidResponse, CallResponseSchema)
    expect(invalid.result.isError).toBe(true)
    const transformed = yield* call(server.handler, headers, 9, "clock.wire", "wire:canonical")
    expect(transformed.result.structuredContent).toEqual({ result: "wire:canonical!" })
  }),
  Effect.scoped,
))

it.effect("MCP uses handler-only codec context instead of its ambient context", () => pipe(
  Effect.gen(function* () {
    const echo = Rpc.make("codec.echo", {
      payload: StoredTextSchema,
      success: StoredTextSchema,
      error: StoredTextSchema,
    })

    const group = RpcGroup.make(echo)
    const innerPrefix = Layer.succeed(StoragePrefix, { value: "inner:" })
    const outerPrefix = Layer.succeed(StoragePrefix, { value: "outer:" })

    const handlers = pipe(
      group.toLayer({ "codec.echo": (text) => Equivalence.strictEqual<string>()(text, "fail") ? Effect.fail("failure") : Effect.succeed(`${text}!`) }),
      Layer.provide(innerPrefix),
    )

    const handlerOnlyRoutes = pipe(
      RpcMcp.layerHttp({ name: "codec", group, path: "/mcp" }),
      Layer.provide(handlers),
    )

    const handlerOnly = yield* makeServer(handlerOnlyRoutes as Layer.Layer<never, unknown, HttpRouter.HttpRouter>)
    const handlerOnlyHeaders = yield* openSession(handlerOnly.handler)
    const handlerOnlyResponse = yield* call(handlerOnly.handler, handlerOnlyHeaders, 2, "codec.echo", "inner:hello")
    const handlerOnlyFailure = yield* call(handlerOnly.handler, handlerOnlyHeaders, 3, "codec.echo", "inner:fail")

    expect(handlerOnlyResponse.result.structuredContent).toEqual({ result: "inner:hello!" })
    expect(handlerOnlyFailure.result.content).toEqual([{ type: "text", text: '"inner:failure"' }])

    const routes = pipe(
      RpcMcp.layerHttp({ name: "codec", group, path: "/mcp" }),
      Layer.provide(handlers),
      Layer.provide(outerPrefix),
    )

    const server = yield* makeServer(routes)
    const headers = yield* openSession(server.handler)
    const response = yield* call(server.handler, headers, 2, "codec.echo", "inner:hello")
    const failure = yield* call(server.handler, headers, 3, "codec.echo", "inner:fail")

    expect(response.result.structuredContent).toEqual({ result: "inner:hello!" })
    expect(failure.result.content).toEqual([{ type: "text", text: '"inner:failure"' }])
  }),
  Effect.scoped,
))

const SubjectSchema = Schema.Record(Schema.String, Schema.Unknown)
const subject = Rpc.make("identity.subject", { success: SubjectSchema }).middleware(AuthorizationRpc)
const identity = RpcGroup.make(subject)
const identityHandlers = identity.toLayer({ "identity.subject": () => AuthorizationSubject })

const captured = Layer.succeed(AuthorizationSubject, { userId: "captured" })

const identityRoutes = pipe(
  RpcMcp.layerHttp({ name: "identity", group: identity, path: "/mcp" }),
  Layer.provide(identityHandlers),
  Layer.provide(AuthorizationRpc.layer),
  Layer.provide(captured),
)

it.effect("MCP authenticates each call rather than trusting sessions or captured identity", () => pipe(
  Effect.gen(function* () {
    const routes = Layer.provide(identityRoutes, ExampleAuthentication)
    const server = yield* makeServer(routes)
    const headers = yield* openSession(server.handler)
    const anonymous = yield* call(server.handler, headers, 2, "identity.subject", null)
    expect(anonymous.result.isError).toBe(true)
    expect(anonymous.result.content).toEqual([{ type: "text", text: '{"_tag":"Unauthenticated"}' }])
    const alice = new globalThis.Headers(headers)
    alice.set("authorization", "Bearer alice-demo")
    const bob = new globalThis.Headers(headers)
    bob.set("authorization", "Bearer bob-demo")

    const aliceCall = call(server.handler, alice, 3, "identity.subject", null)
    const bobCall = call(server.handler, bob, 4, "identity.subject", null)
    const results = yield* Effect.all({ alice: aliceCall, bob: bobCall }, { concurrency: 2 })

    expect(results.alice.result.structuredContent).toMatchObject({ result: { userId: "alice", roles: ["editor"] } })
    expect(results.bob.result.structuredContent).toMatchObject({ result: { userId: "bob", roles: ["reader"] } })
    const unauthenticatedAgain = yield* call(server.handler, headers, 5, "identity.subject", null)
    expect(unauthenticatedAgain.result.isError).toBe(true)
    const unconfigured = yield* makeServer(identityRoutes)
    const unconfiguredHeaders = yield* openSession(unconfigured.handler)
    unconfiguredHeaders.set("authorization", "Bearer alice-demo")
    const missingAuthenticator = yield* call(unconfigured.handler, unconfiguredHeaders, 2, "identity.subject", null)
    expect(missingAuthenticator.result.content).toEqual([{ type: "text", text: '{"_tag":"Unauthenticated"}' }])
  }),
  Effect.scoped,
))
