import { expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Ref, Schema, pipe } from "effect"
import { Rpc, RpcGroup, RpcTest } from "effect/unstable/rpc"
import { AuthorizationSubject } from "effect-domains/authorization"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { Commands } from "effect-domains/commands"

class Greeting extends Context.Service<Greeting, { readonly value: string }>()("test/Commands/Greeting") {}

const greetRpc = Rpc.make("greet", { success: Schema.String })
const greeterRpcs = RpcGroup.make(greetRpc)

class TimeUnavailable extends Schema.TaggedError<TimeUnavailable>()("TimeUnavailable", {
  at: Schema.Date,
}) {}

class HandlerFailed extends Schema.TaggedError<HandlerFailed>()("HandlerFailed", {}) {}

const timeRpc = Commands.rpc("time", {
  payload: Schema.Date,
  success: Schema.Date,
  error: TimeUnavailable,
})

const Greeter = Commands.make({
  name: "test/Commands/Greeter",
  group: greeterRpcs,
})

const clockRpcs = RpcGroup.make(timeRpc)

const Clock = Commands.make({
  name: "test/Commands/Clock",
  group: clockRpcs,
})

const identityRpc = Rpc.make("identity", { success: Schema.String }).middleware(AuthorizationRpc)
const identityRpcs = RpcGroup.make(identityRpc)

const Identity = Commands.make({
  name: "test/Commands/Identity",
  group: identityRpcs,
})

const scopedRpc = Rpc.make("scoped", { success: Schema.Void })
const scopedRpcs = RpcGroup.make(scopedRpc)

const Scoped = Commands.make({
  name: "test/Commands/Scoped",
  group: scopedRpcs,
})

const greet = Effect.fn("Greeter.greet")(function* () {
  const greeting = yield* Greeting
  return greeting.value
})

const identity = Effect.fn("Commands.identity")(function* () {
  yield* AuthorizationSubject
  return "authorized"
})

const scoped = Effect.fn("Commands.scoped")(function* (
  onRelease: () => Effect.Effect<void>,
) {
  yield* Effect.addFinalizer(onRelease)
})

const authenticator = AuthorizationRpc.Authenticator.of({
  authenticate: () => Effect.succeed({}),
})

it.effect("captures command handler services and lets invocation context override them", () => {
  const capturedGreeting = Layer.succeed(Greeting, { value: "captured" })

  const capturedHandlersLayer = pipe(
    Greeter.layer({ greet }),
    Layer.provide(capturedGreeting),
  )

  return pipe(
    Effect.gen(function* () {
      const handlers = yield* pipe(capturedHandlersLayer, Layer.build)
      const greeter = Context.get(handlers, Greeter)
      const captured = yield* greeter.greet(undefined)
      expect(captured).toBe("captured")

      const current = yield* pipe(
        greeter.greet(undefined),
        Effect.provideService(Greeting, { value: "current" }),
      )

      expect(current).toBe("current")
    }),
    Effect.scoped,
  )
})

it.effect("uses middleware-provided services for direct command invocations", () =>
  pipe(
    Effect.gen(function* () {
      const commandLayer = Identity.layer({ identity })
      const handlers = yield* pipe(commandLayer, Layer.build)
      const commands = Context.get(handlers, Identity)

      const result = yield* pipe(
        commands.identity(undefined),
        Effect.provideService(AuthorizationSubject, {}),
      )

      expect(result).toBe("authorized")
    }),
    Effect.scoped,
  ))

it.effect("lets RPC middleware provide command handler services", () => {
  const commandLayer = Identity.layer({ identity })
  const handlers = pipe(Identity.handlers, Layer.provide(commandLayer))

  return pipe(
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(Identity.group)
      const result = yield* client.identity(undefined)
      expect(result).toBe("authorized")
    }),
    Effect.provide(handlers),
    Effect.provide(AuthorizationRpc.layer),
    Effect.provideService(AuthorizationRpc.Authenticator, authenticator),
    Effect.scoped,
  )
})

it.effect("closes each direct command invocation scope before returning", () =>
  pipe(
    Effect.gen(function* () {
      const released = yield* Ref.make(0)
      const onRelease = () => Ref.update(released, (count) => count + 1)
      const invokeScoped = () => scoped(onRelease)
      const commandLayer = Scoped.layer({ scoped: invokeScoped })
      const handlers = yield* pipe(commandLayer, Layer.build)
      const commands = Context.get(handlers, Scoped)

      yield* commands.scoped(undefined)
      const releasedAfterFirstCall = yield* Ref.get(released)
      expect(releasedAfterFirstCall).toBe(1)

      yield* commands.scoped(undefined)
      const releasedAfterSecondCall = yield* Ref.get(released)
      expect(releasedAfterSecondCall).toBe(2)
    }),
    Effect.scoped,
  ))

const failingTime = (released: Ref.Ref<boolean>) =>
  Effect.fn("Commands.failingTime")(function* () {
    yield* Effect.addFinalizer(() => Ref.set(released, true))
    return yield* HandlerFailed.make({})
  }, Effect.scoped)

const mapHandlerFailure = Effect.fn("Commands.mapHandlerFailure")(function* (
  released: Ref.Ref<boolean>,
  at: Date,
) {
  const wasReleased = yield* Ref.get(released)
  expect(wasReleased).toBe(true)
  return yield* TimeUnavailable.make({ at })
})

const failureMapperFor = (released: Ref.Ref<boolean>, at: Date) =>
  Effect.fn("Commands.mapFailure")(function* () {
    return yield* mapHandlerFailure(released, at)
  })

const verifyFinalizerMapping = Effect.fn("Commands.verifyFinalizerMapping")(function* () {
  const released = yield* Ref.make(false)
  const at = new Date("2026-01-02T03:04:05.000Z")
  const time = failingTime(released)
  const failureMapper = failureMapperFor(released, at)
  const catchTags = { HandlerFailed: failureMapper }
  const clockLayer = Clock.layer({ time }, catchTags)
  const handlers = yield* Layer.build(clockLayer)
  const clock = Context.get(handlers, Clock)
  const invocation = clock.time(at)
  const rejected = yield* Effect.flip(invocation)
  const expected = TimeUnavailable.make({ at })
  expect(rejected).toEqual(expected)
})

it.effect("maps tagged invocation failures after handler finalizers", () =>
  pipe(verifyFinalizerMapping(), Effect.scoped),
)

it("derives JSON codecs for transformed RPC schemas", () => {
  const at = new Date("2026-01-02T03:04:05.000Z")
  const failure = TimeUnavailable.make({ at })
  const encodedPayload = Schema.encodeSync(timeRpc.payloadSchema)(at)
  const decodedSuccess = Schema.decodeSync(timeRpc.successSchema)("2026-01-02T03:04:05.000Z")
  const encodedFailure = Schema.encodeSync(timeRpc.errorSchema)(failure)
  const decodedFailure = Schema.decodeSync(timeRpc.errorSchema)(encodedFailure)

  expect(encodedPayload).toBe("2026-01-02T03:04:05.000Z")
  expect(decodedSuccess).toEqual(at)

  expect(encodedFailure).toEqual({
    _tag: "TimeUnavailable",
    at: "2026-01-02T03:04:05.000Z",
  })

  expect(decodedFailure).toEqual(failure)
})
