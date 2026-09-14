import { Application, Part } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { ReportExportExecutionsResource } from "./executions.ts"
import { ReportExportCommands } from "./workflow.ts"
import { ReportSubscriptionsResource } from "./subscriptions.ts"

export const ReportExportsApplication = Application.compile(Application.define({
  name: "report-exports",
  parts: [
    Part.resource(ReportSubscriptionsResource),
    Part.resource(ReportExportExecutionsResource),
    Part.command(ReportExportCommands),
    Part.native(IdentityBundle),
  ],
}))
