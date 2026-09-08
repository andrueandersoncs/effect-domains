import { expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Schema, pipe } from "effect"
import { Commands } from "../src/commands.ts"

const Greeting = Context.Service<{ readonly value: string }>("test/Commands/Greeting")

const Greeter = Commands.make("test/Commands/Greeter", {
  greet: {
    input: Schema.Void,
    output: Schema.String,
    error: Schema.Never,
  },
})

it.effect(
  "captures command handler services and lets invocation context override them",
  () => Effect.scoped(
    Effect.gen(function* () {
      const handlers = yield* pipe(
        Layer.build(
          Greeter.layer({
            greet: () => Effect.map(Greeting, ({ value }) => value),
          }),
        ),
        Effect.provideService(Greeting, { value: "captured" }),
      )
      const greeter = Context.get(handlers, Greeter)
      expect(yield* greeter.greet(undefined)).toBe("captured")
      expect(
        yield* pipe(
          greeter.greet(undefined),
          Effect.provideService(Greeting, { value: "current" }),
        ),
      ).toBe("current")
    }),
  ),
)
