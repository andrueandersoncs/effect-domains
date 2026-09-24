import { BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"
import { runInfrastructure as runInfrastructureRuntime } from "./application-bun-infrastructure.ts"
import { runApplication as runApplicationRuntime } from "./application-bun-runtime.ts"

export const runInfrastructure: typeof runInfrastructureRuntime = Effect.fn("ApplicationBun.runInfrastructure")(runInfrastructureRuntime)
export const runApplication: typeof runApplicationRuntime = Effect.fn("ApplicationBun.runApplication")(runApplicationRuntime)

export const runMain = Effect.fn("ApplicationBun.runMain")(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
  // SAFETY: The cast is valid because application runners provide all runtime layers before this native process boundary.
  yield* Effect.sync(() => BunRuntime.runMain(program as Effect.Effect<A, E>))
})
