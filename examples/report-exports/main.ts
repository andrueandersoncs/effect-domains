import { BunRuntime } from "@effect/platform-bun"
import { Config, Context, Effect, Layer, pipe } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { assertDistinctDatabases } from "@effect-domains/example-support/databases"
import { ApplicationBun } from "effect-domains/application-bun"
import { ReportExportsApplication } from "./application.ts"
import { ReportExportRoutes } from "./routes.ts"
import { ReportExportBackground, ReportExportExecution, ReportExportServices } from "./runtime.ts"

const program = Effect.gen(function* () {
  const executionDatabase = yield* pipe(Config.string("REPORT_EXPORTS_EXECUTION_DB"), Config.withDefault("report-exports-execution.sqlite"),)

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

  const execution = pipe(ReportExportExecution, Layer.provide(executionSql))
  const services = Layer.mergeAll(ReportExportServices, execution)

  return yield* ApplicationBun.run(ReportExportsApplication, {
    database: { migrations: [] },
    services,
    background: ReportExportBackground,
    routes: ReportExportRoutes,
  })
})

pipe(program, BunRuntime.runMain)
