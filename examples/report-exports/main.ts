import { BunRuntime } from "@effect/platform-bun"
import { Layer, pipe } from "effect"
import { ExampleWeb } from "@effect-domains/example-web/serve"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { ApplicationBun } from "effect-domains/application-bun"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { ReportExportsApplication } from "./application.ts"
import { ReportExportMigrations } from "./migrations.ts"
import { ReportExportRoutes } from "./routes.ts"
import { ReportExportWebAssets } from "./web/assets.ts"
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
  execution,
)

const web = ExampleWeb.layerHttp({
  title: "Report exports",
  accent: "#365314",
  ...ReportExportWebAssets,
})

const initialize = seedReportExportSubscriptions()
const routes = Layer.mergeAll(ReportExportRoutes, web)

pipe(ApplicationBun.run(ReportExportsApplication, {
  database: { migrations: ReportExportMigrations },
  services,
  initialize,
  background: ReportExportBackground,
  routes,
}), BunRuntime.runMain)

