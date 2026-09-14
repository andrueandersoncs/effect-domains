import { Layer, pipe } from "effect"
import { StaticSpa } from "effect-domains/static-spa"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { ApplicationBun } from "effect-domains/application-bun"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { ReportExportsApplication } from "./application.ts"
import { ReportExportExecutionStoreLive } from "./executions.ts"
import { ReportExportMigrations } from "./migrations.ts"
import { ReportExportRoutes } from "./routes.ts"
import { ReportExportBackground, ReportExportExecution, ReportExportServices } from "./runtime.ts"
import { seedReportExportSubscriptions } from "./subscriptions.ts"

const privateClient = SqliteBunRuntime.privateClient({
  application: "report-exports",
  purpose: "execution",
})

const execution = pipe(
  ReportExportExecution,
  Layer.provide(privateClient),
)

const identity = ExampleIdentity.layer("report-exports")

const services = Layer.mergeAll(
  identity,
  ReportExportServices,
  ReportExportExecutionStoreLive,
  execution,
)

const webBase = new URL("./web/", import.meta.url)
const web = StaticSpa.layerHttp({ title: "Report exports", accent: "#365314", base: webBase })

const initialize = seedReportExportSubscriptions()
const routes = Layer.mergeAll(ReportExportRoutes, web)

const program = ApplicationBun.run(ReportExportsApplication, {
  database: { migrations: ReportExportMigrations },
  services,
  initialize,
  background: ReportExportBackground,
  routes,
})

pipe(program, ApplicationBun.runMain)
