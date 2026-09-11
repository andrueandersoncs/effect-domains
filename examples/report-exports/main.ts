import { BunRuntime } from "@effect/platform-bun"
import { Config, Effect, Layer, pipe } from "effect"
import { ExampleWeb } from "@effect-domains/example-web/serve"
import { privateSqlite } from "@effect-domains/example-support/databases"
import { ApplicationBun } from "effect-domains/application-bun"
import { ReportExportsApplication } from "./application.ts"
import { ReportExportMigrations } from "./migrations.ts"
import { ReportExportRoutes } from "./routes.ts"
import { ReportExportWebAssets } from "./web/assets.ts"
import { ReportExportBackground, ReportExportExecution, ReportExportServices } from "./runtime.ts"
import { seedReportExportSubscriptions } from "./subscriptions.ts"

const program = Effect.gen(function* () {
  const executionDatabase = yield* pipe(Config.string("REPORT_EXPORTS_EXECUTION_DB"), Config.withDefault("data/report-exports-execution.sqlite"),)
  const executionSql = privateSqlite(executionDatabase)
  const execution = pipe(ReportExportExecution, Layer.provide(executionSql))
  const services = Layer.mergeAll(ReportExportServices, execution)
  const initialize = seedReportExportSubscriptions()

  const web = ExampleWeb.layerHttp({
    title: "Report exports",
    accent: "#365314",
    ...ReportExportWebAssets,
  })

  const routes = Layer.mergeAll(ReportExportRoutes, web)

  return yield* ApplicationBun.run(ReportExportsApplication, {
    database: { migrations: ReportExportMigrations },
    services,
    initialize,
    background: ReportExportBackground,
    routes,
  })
})

pipe(program, BunRuntime.runMain)
