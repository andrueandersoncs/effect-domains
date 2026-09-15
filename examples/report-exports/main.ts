import { Layer, pipe } from "effect"
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


const initialize = seedReportExportSubscriptions()

const program = ApplicationBun.run(ReportExportsApplication, {
  database: { migrations: ReportExportMigrations },
  services,
  initialize,
  background: ReportExportBackground,
  routes: ReportExportRoutes,
  ui: {
    presentation: {
      title: "Report exports",
      description: "Generate, inspect, approve, and reconcile durable financial report exports.",
    },
  },
  telemetry: {
    protocol: "http/json",
    resource: {
      serviceName: "report-exports",
      attributes: { "service.namespace": "effect-domains.examples" },
    },
  },
})

pipe(program, ApplicationBun.runMain)
