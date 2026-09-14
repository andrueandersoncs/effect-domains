import { Application, Part } from "effect-domains/application"

import {
  SupportAgentsResource,
  SupportCaseEventsResource,
  SupportCasesResource,
  SupportCustomersResource,
} from "./resources.ts"

import { SupportCaseOperations } from "./sqlite.ts"

const directoryParts = [
  Part.resource(SupportCustomersResource),
  Part.resource(SupportAgentsResource),
]

const SupportDirectory = Application.define({
  name: "support-directory",
  parts: directoryParts,
})

const caseManagementParts = [
  Part.resource(SupportCasesResource),
  Part.resource(SupportCaseEventsResource),
  Part.command(SupportCaseOperations),
]

const CaseManagement = Application.define({
  name: "case-management",
  parts: caseManagementParts,
})

const applicationParts = [
  Part.application(SupportDirectory),
  Part.application(CaseManagement),
]

const application = Application.define({
  name: "support-cases",
  parts: applicationParts,
})

export const SupportCasesApplication = Application.compile(application)
