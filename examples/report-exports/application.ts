import { Application } from "effect-domains/application"
import { ReportExportCommands } from "./workflow.ts"

export const ReportExportsApplication = Application.make({ name: "report-exports", parts: [ReportExportCommands] })
