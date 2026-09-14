import { Application } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { ReportExportExecutionsResource } from "./executions.ts"
import { ReportExportCommands } from "./workflow.ts"
import { ReportSubscriptionsResource } from "./subscriptions.ts"

export const ReportExportsApplication = Application.make({
  name: "report-exports",
  parts: [ReportSubscriptionsResource, ReportExportExecutionsResource, ReportExportCommands, IdentityBundle],
})
