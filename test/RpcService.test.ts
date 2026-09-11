import { expect, it } from "@effect/vitest"
import { Effect, Layer, Schema, pipe } from "effect"
import { Rpc, RpcClient, RpcGroup } from "effect/unstable/rpc"
import { RpcService } from "effect-domains/rpc-service"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false

class EchoUnavailable extends Schema.TaggedError<EchoUnavailable>()("EchoUnavailable", {}) {}

const ping = Rpc.make("ping", { success: Schema.String })
const pong = Rpc.make("pong", { success: Schema.String })
const boom = Rpc.make("boom", { success: Schema.String, error: EchoUnavailable })
const group = RpcGroup.make(ping, pong, boom)
const Echo = RpcService.make({ name: "test/RpcService/Echo", group })
const unavailable = EchoUnavailable.make({})

const pingHandler = Effect.fn("RpcService.testPing")(function* () {
  return "pong"
})

const pongHandler = Effect.fn("RpcService.testPong")(function* () {
  const client = yield* Echo
  return yield* client.ping()
})

const handlers = group.toLayer({
  ping: pingHandler,
  pong: () => pongHandler() as Effect.Effect<string>,
  boom: () => Effect.fail(unavailable),
})

const echoRuntime = pipe(Echo.layer, Layer.provide(handlers))

const protocolRequiresProtocol = true satisfies Equal<
  Extract<Layer.Services<typeof Echo.layerProtocol>, RpcClient.Protocol>,
  RpcClient.Protocol
>
void protocolRequiresProtocol

const inProcessOmitsProtocol = true satisfies Equal<
  Extract<Layer.Services<typeof Echo.layer>, RpcClient.Protocol>,
  never
>
void inProcessOmitsProtocol

it.effect("in-process service calls group methods and declared errors", () => pipe(
  Effect.gen(function* () {
    const client = yield* Echo
    const pinged = yield* client.ping()
    expect(pinged).toBe("pong")
    const failed = yield* pipe(client.boom(), Effect.flip)
    expect(failed._tag).toBe("EchoUnavailable")
  }),
  Effect.provide(echoRuntime),
  Effect.scoped,
))

it.effect("handlers can yield the service to call a sibling operation", () => pipe(
  Effect.gen(function* () {
    const client = yield* Echo
    const sibling = yield* client.pong()
    expect(sibling).toBe("pong")
  }),
  Effect.provide(echoRuntime),
  Effect.scoped,
))
