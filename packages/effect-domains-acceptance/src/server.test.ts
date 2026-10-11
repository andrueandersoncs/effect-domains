import { expect, it } from "@effect/vitest"
import { Effect, Function, Option, pipe } from "effect"
import { join } from "node:path"
import { ServerSpec, call, scopedTemporaryDirectory, serve } from "./server.ts"

const noVariables = Function.constant({})

const exitedTest = Effect.gen(function* () {
  const scratch = yield* scopedTemporaryDirectory("effect-domains-acceptance-server-test-")
  const artifacts = join(scratch, "artifacts")

  const missingEntry = ServerSpec.make({
    application: "acceptance-test",
    entry: "packages/effect-domains-acceptance/missing-entry.ts",
    prefix: "effect-domains-acceptance-server-test-",
    artifacts,
  })

  const served = serve(missingEntry, noVariables)
  const failure = yield* pipe(served, Effect.scoped, Effect.flip)

  expect(failure.boundary).toBe("fixture")
  expect(failure.message).toContain("Application exited with")
})

const anonymous = Option.none()

const unreachableTest = Effect.gen(function* () {
  const reply = call("http://127.0.0.1:9", "ratings.rate", {}, anonymous)
  const failure = yield* Effect.flip(reply)

  expect(failure.message).toBe("Fixture HTTP call failed before a decodable reply")
})

it.live("a served application that exits before readiness fails the fixture with its exit", Function.constant(exitedTest))
it.effect("an unreachable application fails the call with a fixed, secret-free message", Function.constant(unreachableTest))
