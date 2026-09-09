import { expect, it } from "@effect/vitest"
import { Array, Effect, Layer, Option, Ref, Schema, Struct, pipe } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { ExampleAuthentication } from "@effect-domains/example-support/authentication"
import { Application } from "effect-domains/application"
import { ApplicationAdmin } from "effect-domains/application-admin"
import { AuthorizationSubject } from "effect-domains/authorization"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { Commands } from "effect-domains/commands"
import { ApplicationInspect } from "effect-domains/application-inspect"

const SubjectSchema = Schema.Record(Schema.String, Schema.Unknown)
const identify = Rpc.make("identity", { success: SubjectSchema }).middleware(AuthorizationRpc)
const mutate = Rpc.make("mutate", { success: Schema.Number }).middleware(AuthorizationRpc)
const identityGroup = RpcGroup.make(identify, mutate)
const javascript = ""
const stylesheet = ""

const HeaderValuesSchema = Schema.Record(Schema.String, Schema.String)

const call = Effect.fn("Admin.testCall")(function* (
  handler: ReturnType<
    typeof HttpRouter.toWebHandler<never, never, HttpRouter.HttpRouter, never>
  >["handler"],
  operation: string,
  input: Schema.Json,
  headers: Record<string, string> = {},
) {
  const body = JSON.stringify({ operation, input })

  const request = new Request("http://localhost/admin/api/call", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  })

  const response = yield* Effect.promise(() => handler(request))
  const decoded = yield* Effect.promise(() => response.json())
  return { status: response.status, body: decoded }
})

const serverFor = Effect.fn("Admin.testServer")(function* (
  routes: Layer.Layer<never, unknown, HttpRouter.HttpRouter>,
) {
  const server = HttpRouter.toWebHandler(routes, { disableLogger: true })
  yield* Effect.addFinalizer(() => Effect.promise(server.dispose))
  return server.handler
})

it.effect("admin authenticates each invocation and rejects cross-origin writes before handlers", () => pipe(
  Effect.gen(function* () {
    const writes = yield* Ref.make(0)

    const handlers = identityGroup.toLayer({
      identity: () => AuthorizationSubject,
      mutate: () => Ref.updateAndGet(writes, (value) => value + 1),
    })

    const application = Application.make({ name: "identity", resources: [], commands: [{ group: identityGroup, handlers }] })
    const capturedSubject = Layer.succeed(AuthorizationSubject, { userId: "captured" })

    const routes = pipe(
      ApplicationAdmin.layerHttp({ application, javascript, stylesheet }),
      Layer.provide(application.handlers),
      Layer.provide(AuthorizationRpc.layer),
      Layer.provide(ExampleAuthentication),
      Layer.provide(capturedSubject),
    )

    const handler = yield* serverFor(routes)
    const denied = yield* call(handler, "mutate", null)
    expect(denied.status).toBe(422)
    expect(denied.body).toEqual({ error: { _tag: "Unauthenticated" } })

    const alice = HeaderValuesSchema.make({ authorization: "Bearer alice-demo", origin: "http://localhost" })
    const bob = HeaderValuesSchema.make({ authorization: "Bearer bob-demo", origin: "http://localhost" })
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

    const reboundRequest = new Request("http://rebound.example/admin/api/call", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer alice-demo",
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
))

class TooEarly extends Schema.TaggedError<TooEarly>()("TooEarly", { at: Schema.Date }) {}
const time = Commands.rpc("time", { payload: Schema.Date, success: Schema.Date, error: TooEarly })
const clear = Rpc.make("clear")
const broken = Rpc.make("broken", { success: Schema.String })
const clock = RpcGroup.make(time, clear, broken)
const cutoff = new Date("2026-01-01T00:00:00.000Z")

it.effect("admin preserves wire codecs and void while distinguishing validation, declared errors and defects", () => pipe(
  Effect.gen(function* () {
    const handlers = clock.toLayer({
      time: (date) => date < cutoff ? TooEarly.make({ at: date }) : Effect.succeed(date),
      clear: () => Effect.void,
      broken: () => Effect.die("private database details"),
    })

    const application = Application.make({ name: "clock", resources: [], commands: [{ group: clock, handlers }] })

    const routes = pipe(
      ApplicationAdmin.layerHttp({ application, javascript, stylesheet }),
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

it("inspection publishes middleware errors when the RPC declares no own errors", () => {
  const probe = Rpc.make("probe", { success: Schema.String }).middleware(AuthorizationRpc)
  const group = RpcGroup.make(probe)
  const handlers = group.toLayer({ probe: () => Effect.succeed("ok") })
  const application = Application.make({ name: "probe", resources: [], commands: [{ group, handlers }] })
  const inspection = ApplicationInspect.describe(application)
  const middlewares = Array.fromIterable(probe.middlewares)
  const middlewareErrors = Array.map(middlewares, Struct.get("error"))
  const expected = Schema.toJsonSchemaDocument(Schema.toCodecJson(Schema.Union([probe.errorSchema, ...middlewareErrors])))
  const operationOption = Array.get(inspection.operations, 0)
  const operation = Option.getOrUndefined(operationOption)
  expect(operation?.name).toBe("probe")
  expect(operation?.error).toEqual(expected)
})
