import { expect, it } from "@effect/vitest"
import { Array, Deferred, Effect, Equivalence, Fiber, Layer, Option, Ref, Schema, Struct, pipe } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { TestIdentity, sessionFor } from "./identity-fixture.ts"
import { StoragePrefix, StoredTextSchema } from "./prefix-codec.ts"
import { Application, Part } from "effect-domains/application"
import { ApplicationUi } from "effect-domains/application-ui"
import { AuthorizationSubject } from "effect-domains/authorization"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { ApplicationInspect } from "effect-domains/application-inspect"

const SubjectSchema = Schema.Record(Schema.String, Schema.Unknown)
const identify = Rpc.make("identity", { success: SubjectSchema }).middleware(AuthorizationRpc)
const mutate = Rpc.make("mutate", { success: Schema.Number }).middleware(AuthorizationRpc)
const identityGroup = RpcGroup.make(identify, mutate)
const javascript = ""
const stylesheet = ""

const HeaderValuesSchema = Schema.Record(Schema.String, Schema.String)

const call = Effect.fn("ApplicationUi.testCall")(function* (
  handler: ReturnType<
    typeof HttpRouter.toWebHandler<never, never, HttpRouter.HttpRouter, never>
  >["handler"],
  operation: string,
  input: Schema.Json,
  headers: Record<string, string> = {},
) {
  const body = JSON.stringify({ operation, input })

  const request = new Request("http://localhost/api/call", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  })

  const response = yield* Effect.promise(() => handler(request))
  const decoded = yield* Effect.promise(() => response.json())
  return { status: response.status, body: decoded }
})

const serverFor = Effect.fn("ApplicationUi.testServer")(function* (
  routes: Layer.Layer<never, unknown, HttpRouter.HttpRouter>,
) {
  const server = HttpRouter.toWebHandler(routes, { disableLogger: true })
  yield* Effect.addFinalizer(() => Effect.promise(server.dispose))
  return server.handler
})

it.effect("application UI authenticates each invocation and rejects cross-origin writes before handlers", () => pipe(
  Effect.gen(function* () {
    const writes = yield* Ref.make(0)

    const handlers = identityGroup.toLayer({
      identity: () => AuthorizationSubject,
      mutate: () => Ref.updateAndGet(writes, (value) => value + 1),
    })

    const parts = [Part.native({ group: identityGroup, handlers })]
    const definition = Application.define({ name: "identity", parts })
    const application = Effect.runSync(Application.compile(definition))
    const capturedSubject = Layer.succeed(AuthorizationSubject, { userId: "captured" })
    const authenticator = yield* AuthorizationRpc.Authenticator
    const authentication = Layer.succeed(AuthorizationRpc.Authenticator, authenticator)

    const routes = pipe(
      ApplicationUi.layerHttp({
        application,
        javascript,
        stylesheet,
        presentation: { title: "Identity application", description: "Generated from application contracts." },
      }),
      Layer.provide(application.handlers),
      Layer.provide(AuthorizationRpc.layer),
      Layer.provide(capturedSubject),
      Layer.provide(authentication),
    )

    const handler = yield* serverFor(routes)
    const documentRequest = new Request("http://localhost/")
    const documentResponse = yield* Effect.promise(() => handler(documentRequest))
    expect(documentResponse.status).toBe(200)
    const document = yield* Effect.promise(() => documentResponse.text())
    expect(document).toContain('src="/client.js"')

    const metadataRequest = new Request("http://localhost/api")
    const metadataResponse = yield* Effect.promise(() => handler(metadataRequest))
    expect(metadataResponse.status).toBe(200)
    const metadata = yield* Effect.promise(() => metadataResponse.json())

    expect(metadata).toMatchObject({
      application: "identity",
      presentation: {
        title: "Identity application",
        description: "Generated from application contracts.",
      },
    })

    const denied = yield* call(handler, "mutate", null)
    expect(denied.status).toBe(422)
    expect(denied.body).toEqual({ error: { _tag: "Unauthenticated" } })

    const aliceSession = yield* sessionFor("alice")
    const bobSession = yield* sessionFor("bob")
    const alice = HeaderValuesSchema.make({ ...aliceSession, origin: "http://localhost" })
    const bob = HeaderValuesSchema.make({ ...bobSession, origin: "http://localhost" })
    const aliceIdentity = call(handler, "identity", null, alice)
    const bobIdentity = call(handler, "identity", null, bob)

    const identities = yield* Effect.all(
      { alice: aliceIdentity, bob: bobIdentity },
      { concurrency: 2 },
    )

    expect(identities.alice.body).toMatchObject({ result: { userId: "alice" } })
    expect(identities.bob.body).toMatchObject({ result: { userId: "bob" } })

    const foreignHeaders = HeaderValuesSchema.make({ ...alice, origin: "http://foreign.example" })
    const foreign = yield* call(handler, "mutate", null, foreignHeaders)
    expect(foreign.status).toBe(403)

    const nullOriginHeaders = HeaderValuesSchema.make({ ...alice, origin: "null" })
    const nullOrigin = yield* call(handler, "mutate", null, nullOriginHeaders)
    expect(nullOrigin.status).toBe(403)

    const reboundBody = JSON.stringify({ operation: "mutate", input: null })

    const reboundRequest = new Request("http://rebound.example/api/call", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: aliceSession.authorization,
        origin: "http://rebound.example",
      },
      body: reboundBody,
    })

    const rebound = yield* Effect.promise(() => handler(reboundRequest))
    expect(rebound.status).toBe(403)

    const initialWrites = yield* Ref.get(writes)
    expect(initialWrites).toBe(0)

    const accepted = yield* call(handler, "mutate", null, alice)
    expect(accepted.body).toEqual({ result: 1 })

    const unauthenticated = yield* call(handler, "mutate", null)
    expect(unauthenticated.status).toBe(422)

    const finalWrites = yield* Ref.get(writes)
    expect(finalWrites).toBe(1)
  }),
  Effect.scoped,
  Effect.provide(TestIdentity),
))

class TooEarly extends Schema.TaggedError<TooEarly>()("TooEarly", { at: Schema.Date }) {}
const DateCodecSchema = Schema.toCodecJson(Schema.Date)
const TooEarlyCodecSchema = Schema.toCodecJson(TooEarly)

const time = Rpc.make("time", { payload: DateCodecSchema, success: DateCodecSchema, error: TooEarlyCodecSchema })
const clear = Rpc.make("clear")
const broken = Rpc.make("broken", { success: Schema.String })
const clock = RpcGroup.make(time, clear, broken)
const cutoff = new Date("2026-01-01T00:00:00.000Z")

it.effect("application UI preserves wire codecs and void while distinguishing validation, declared errors and defects", () => pipe(
  Effect.gen(function* () {
    const handlers = clock.toLayer({
      time: (date) => date < cutoff ? TooEarly.make({ at: date }) : Effect.succeed(date),
      clear: () => Effect.void,
      broken: () => Effect.die("private database details"),
    })

    const parts = [Part.native({ group: clock, handlers })]
    const definition = Application.define({ name: "clock", parts })
    const application = Effect.runSync(Application.compile(definition))

    const routes = pipe(
      ApplicationUi.layerHttp({ application, javascript, stylesheet }),
      Layer.provide(application.handlers),
    )

    const handler = yield* serverFor(routes)
    const valid = "2026-09-09T00:00:00.000Z"
    const validResponse = yield* call(handler, "time", valid)
    expect(validResponse).toEqual({ status: 200, body: { result: valid } })

    const early = "2025-01-01T00:00:00.000Z"
    const earlyResponse = yield* call(handler, "time", early)
    expect(earlyResponse).toEqual({ status: 422, body: { error: { _tag: "TooEarly", at: early } } })

    const invalidDate = yield* call(handler, "time", "not a date")
    expect(invalidDate.status).toBe(400)

    const absent = yield* call(handler, "absent", null)
    expect(absent.status).toBe(400)

    const cleared = yield* call(handler, "clear", null)
    expect(cleared).toEqual({ status: 200, body: { result: null } })

    const defect = yield* call(handler, "broken", null)
    expect(defect.status).toBe(500)
    const serializedDefect = JSON.stringify(defect.body)
    const defectExpectation = expect(serializedDefect)
    defectExpectation.not.toContain("private database details")
  }),
  Effect.scoped,
))

it.effect("application UI isolates a slow call from an unrelated handler defect", () => pipe(
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const slow = Rpc.make("slow", { success: Schema.String })
    const defect = Rpc.make("defect", { success: Schema.String })
    const group = RpcGroup.make(slow, defect)

    const slowHandler = Effect.fn("ApplicationUi.testSlowHandler")(function* () {
      yield* Deferred.succeed(started, undefined)
      yield* Deferred.await(release)
      return "healthy"
    })

    const handlers = group.toLayer({
      slow: slowHandler,
      defect: () => Effect.die("unrelated defect"),
    })

    const parts = [Part.native({ group, handlers })]
    const definition = Application.define({ name: "isolation", parts })
    const application = Effect.runSync(Application.compile(definition))

    const routes = pipe(
      ApplicationUi.layerHttp({ application, javascript, stylesheet }),
      Layer.provide(application.handlers),
    )

    const handler = yield* serverFor(routes)

    const healthy = yield* pipe(
      call(handler, "slow", null),
      Effect.forkScoped,
    )

    yield* Deferred.await(started)
    const defectResponse = yield* call(handler, "defect", null)

    yield* Deferred.succeed(release, undefined)

    const healthyResponse = yield* Fiber.join(healthy)

    expect(defectResponse.status).toBe(500)
    expect(healthyResponse).toEqual({ status: 200, body: { result: "healthy" } })
  }),
  Effect.scoped,
))

it.effect("application UI uses handler-only codec context instead of its ambient context", () => pipe(
  Effect.gen(function* () {
    const echo = Rpc.make("echo", {
      payload: StoredTextSchema,
      success: StoredTextSchema,
      error: StoredTextSchema,
    })

    const group = RpcGroup.make(echo)
    const innerPrefix = Layer.succeed(StoragePrefix, { value: "inner:" })
    const outerPrefix = Layer.succeed(StoragePrefix, { value: "outer:" })

    const handlers = pipe(
      group.toLayer({ echo: (text) => Equivalence.strictEqual<string>()(text, "fail") ? Effect.fail("failure") : Effect.succeed(`${text}!`) }),
      Layer.provide(innerPrefix),
    )

    const parts = [Part.native({ group, handlers })]
    const definition = Application.define({ name: "codec", parts })
    const application = Effect.runSync(Application.compile(definition))

    const handlerOnlyRoutes = pipe(
      ApplicationUi.layerHttp({ application, javascript, stylesheet }),
      Layer.provide(application.handlers),
    )

    const handlerOnly = yield* serverFor(handlerOnlyRoutes as Layer.Layer<never, unknown, HttpRouter.HttpRouter>)
    const handlerOnlyResponse = yield* call(handlerOnly, "echo", "inner:hello")
    const handlerOnlyFailure = yield* call(handlerOnly, "echo", "inner:fail")

    expect(handlerOnlyResponse).toEqual({ status: 200, body: { result: "inner:hello!" } })
    expect(handlerOnlyFailure).toEqual({ status: 422, body: { error: "inner:failure" } })

    const routes = pipe(
      ApplicationUi.layerHttp({ application, javascript, stylesheet }),
      Layer.provide(application.handlers),
      Layer.provide(outerPrefix),
    )

    const handler = yield* serverFor(routes)
    const response = yield* call(handler, "echo", "inner:hello")
    const failure = yield* call(handler, "echo", "inner:fail")

    expect(response).toEqual({ status: 200, body: { result: "inner:hello!" } })
    expect(failure).toEqual({ status: 422, body: { error: "inner:failure" } })
  }),
  Effect.scoped,
))

it("inspection publishes middleware errors when the RPC declares no own errors", () => {
  const probe = Rpc.make("probe", { success: Schema.String }).middleware(AuthorizationRpc)
  const group = RpcGroup.make(probe)
  const handlers = group.toLayer({ probe: () => Effect.succeed("ok") })
  const parts = [Part.native({ group, handlers })]
  const definition = Application.define({ name: "probe", parts })
  const application = Effect.runSync(Application.compile(definition))
  const inspection = ApplicationInspect.describe(application)
  const middlewares = Array.fromIterable(probe.middlewares)
  const middlewareErrors = Array.map(middlewares, Struct.get("error"))
  const expected = Schema.toJsonSchemaDocument(Schema.toCodecJson(Schema.Union([probe.errorSchema, ...middlewareErrors])))
  const operationOption = Array.get(inspection.operations, 0)
  const operation = Option.getOrUndefined(operationOption)
  expect(operation?.name).toBe("probe")
  expect(operation?.error).toEqual(expected)
})
