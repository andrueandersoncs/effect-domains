import { BunRuntime } from "@effect/platform-bun"
import { Config, Effect, pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { DurableWorkflowsApplication } from "./application.ts"
import { DurableWorkflowRoutes } from "./routes.ts"
import { DurableWorkflowBackground, DurableWorkflowExecution, DurableWorkflowServices } from "./runtime.ts"

const program = Effect.gen(function* () {
  const executionDatabase = yield* pipe(Config.string("DURABLE_WORKFLOWS_EXECUTION_DB"), Config.withDefault("durable-workflows-execution.sqlite"),)

  return yield* ApplicationBun.run(DurableWorkflowsApplication, {
    database: { migrations: [] },
    execution: {
      database: executionDatabase,
      layer: DurableWorkflowExecution,
    },
    services: DurableWorkflowServices,
    background: DurableWorkflowBackground,
    routes: DurableWorkflowRoutes,
  })
})

pipe(program, BunRuntime.runMain)
