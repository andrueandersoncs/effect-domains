import { BunRuntime } from "@effect/platform-bun"
import { Config, Context, Effect, Layer, pipe } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { assertDistinctDatabases } from "@effect-domains/example-support/databases"
import { ApplicationBun } from "effect-domains/application-bun"
import { DurableWorkflowsApplication } from "./application.ts"
import { DurableWorkflowRoutes } from "./routes.ts"
import { DurableWorkflowBackground, DurableWorkflowExecution, DurableWorkflowServices } from "./runtime.ts"

const program = Effect.gen(function* () {
  const executionDatabase = yield* pipe(Config.string("DURABLE_WORKFLOWS_EXECUTION_DB"), Config.withDefault("durable-workflows-execution.sqlite"),)


  const executionSql = pipe(Effect.gen(function* () {
    const applicationSql = yield* SqlClient.SqlClient

    const verifyDatabase = (context: Context.Context<SqlClient.SqlClient>) => {
      const executionSql = Context.get(context, SqlClient.SqlClient)
      return assertDistinctDatabases(applicationSql, executionSql)
    }

    return pipe(
      SqliteClient.layer({ filename: executionDatabase }),
      Layer.tap(verifyDatabase),
    )
  }), Layer.unwrap)

  const execution = pipe(DurableWorkflowExecution, Layer.provide(executionSql))
  const services = Layer.mergeAll(DurableWorkflowServices, execution)

  return yield* ApplicationBun.run(DurableWorkflowsApplication, {
    database: { migrations: [] },
    services,
    background: DurableWorkflowBackground,
    routes: DurableWorkflowRoutes,
  })
})

pipe(program, BunRuntime.runMain)
