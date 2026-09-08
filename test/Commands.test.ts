import { expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Schema, pipe } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Commands } from "../src/commands.ts"

class Greeting extends Context.Service<Greeting, { readonly value: string }>()("test/Commands/Greeting") {}

const greetRpc = Rpc.make("greet", { success: Schema.String })
const greeterRpcs = RpcGroup.make(greetRpc)

const Greeter = Commands.make({
  name: "test/Commands/Greeter",
  group: greeterRpcs,
})

const greet = Effect.fn("Greeter.greet")(function* () {
  const greeting = yield* Greeting
  return greeting.value
})

it.effect("captures command handler services and lets invocation context override them", () => {
  const capturedGreeting = Layer.succeed(Greeting, { value: "captured" })
  const handlersLayer = Greeter.layer({ greet })
  const capturedHandlersLayer = Layer.provide(handlersLayer, capturedGreeting)

  const program = Effect.gen(function* () {
    const handlers = yield* Layer.build(capturedHandlersLayer)
    const greeter = Context.get(handlers, Greeter)
    const captured = yield* greeter.greet(undefined)
    expect(captured).toBe("captured")

    const current = yield* pipe(
      greeter.greet(undefined),
      Effect.provideService(Greeting, { value: "current" }),
    )

    expect(current).toBe("current")
  })

  const scopedProgram = Effect.scoped(program)
  return scopedProgram
})
