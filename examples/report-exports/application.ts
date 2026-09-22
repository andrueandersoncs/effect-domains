import { Application, Part } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { ReportExportAuditsResource } from "./audit.ts"
import { ReportExportExecutionsResource } from "./executions.ts"
import { ReportExportCommands } from "./workflow.ts"
import { ReportSubscriptionsResource } from "./subscriptions.ts"
import { Effect } from "effect"

const parts = [
  Part.resource(ReportSubscriptionsResource),
  Part.resource(ReportExportExecutionsResource),
  Part.resource(ReportExportAuditsResource),
  Part.command(ReportExportCommands),
  Part.native(IdentityBundle),
]

const reportExports = Application.define({ name: "report-exports", parts })

const reportExportsCompiler = Application.compile(reportExports)
const reportExportsApplication = Effect.runSync(reportExportsCompiler)

export { reportExportsApplication as ReportExportsApplication }
