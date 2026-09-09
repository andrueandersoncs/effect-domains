import { expect, it } from "@effect/vitest"
import { Array, Effect, Layer, Ref, Schema, pipe } from "effect"
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

type Handler = (request: Request) => Promise<Response>
const call = Effect.fn("Admin.testCall")(function* (handler: Handler, operation: string, input: Schema.Json, headers: Record<string, string> = {}) {
  const response = yield* Effect.promise(() => handler(new Request("http://localhost/admin/api/call", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ operation, input }),
  })))
  const body: unknown = yield* Effect.promise(() => response.json())
  return { status: response.status, body }
})
const serverFor = Effect.fn("Admin.testServer")(function* (routes: Layer.Layer<never, unknown, HttpRouter.HttpRouter>) {
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
    const routes = pipe(
      ApplicationAdmin.layerHttp({ application, javascript, stylesheet }),
      Layer.provide(application.handlers),
      Layer.provide(AuthorizationRpc.layer),
      Layer.provide(ExampleAuthentication),
      Layer.provide(Layer.succeed(AuthorizationSubject, { userId: "captured" })),
    )
    const handler = yield* serverFor(routes)
    const denied = yield* call(handler, "mutate", null)
    expect(denied.status).toBe(422)
    expect(denied.body).toEqual({ error: { _tag: "Unauthenticated" } })
    const alice = { authorization: "Bearer alice-demo", origin: "http://localhost" }
    const bob = { authorization: "Bearer bob-demo", origin: "http://localhost" }
    const identities = yield* Effect.all({
      alice: call(handler, "identity", null, alice),
      bob: call(handler, "identity", null, bob),
    }, { concurrency: 2 })
    expect(identities.alice.body).toMatchObject({ result: { userId: "alice" } })
    expect(identities.bob.body).toMatchObject({ result: { userId: "bob" } })
    const foreign = yield* call(handler, "mutate", null, { ...alice, origin: "http://foreign.example" })
    expect(foreign.status).toBe(403)
    const nullOrigin = yield* call(handler, "mutate", null, { ...alice, origin: "null" })
    expect(nullOrigin.status).toBe(403)
    const rebound = yield* Effect.promise(() => handler(new Request("http://rebound.example/admin/api/call", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer alice-demo", origin: "http://rebound.example" },
      body: JSON.stringify({ operation: "mutate", input: null }),
    })))
    expect(rebound.status).toBe(403)
    expect(yield* Ref.get(writes)).toBe(0)
    expect((yield* call(handler, "mutate", null, alice)).body).toEqual({ result: 1 })
    expect((yield* call(handler, "mutate", null)).status).toBe(422)
    expect(yield* Ref.get(writes)).toBe(1)
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
    const handler = yield* serverFor(pipe(ApplicationAdmin.layerHttp({ application, javascript, stylesheet }), Layer.provide(application.handlers)))
    const valid = "2026-09-09T00:00:00.000Z"
    expect(yield* call(handler, "time", valid)).toEqual({ status: 200, body: { result: valid } })
    const early = "2025-01-01T00:00:00.000Z"
    expect(yield* call(handler, "time", early)).toEqual({ status: 422, body: { error: { _tag: "TooEarly", at: early } } })
    expect((yield* call(handler, "time", "not a date")).status).toBe(400)
    expect((yield* call(handler, "absent", null)).status).toBe(400)
    expect(yield* call(handler, "clear", null)).toEqual({ status: 200, body: { result: null } })
    const defect = yield* call(handler, "broken", null)
    expect(defect.status).toBe(500)
    expect(JSON.stringify(defect.body)).not.toContain("private database details")
  }),
  Effect.scoped,
))

it("inspection publishes middleware errors when the RPC declares no own errors", () => {
  const probe = Rpc.make("probe", { success: Schema.String }).middleware(AuthorizationRpc)
  const group = RpcGroup.make(probe)
  const handlers = group.toLayer({ probe: () => Effect.succeed("ok") })
  const application = Application.make({ name: "probe", resources: [], commands: [{ group, handlers }] })
  const inspection = ApplicationInspect.describe(application)
  const middlewareErrors = Array.map(Array.fromIterable(probe.middlewares), (middleware) => middleware.error)
  const expected = Schema.toJsonSchemaDocument(Schema.toCodecJson(Schema.Union([probe.errorSchema, ...middlewareErrors])))

  const operation = inspection.operations[0]
  expect(operation?.name).toBe("probe")
  expect(operation?.error).toEqual(expected)
})
