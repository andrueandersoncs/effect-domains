import { Application, Part } from "effect-domains/application"

import {
  SupportAgentsResource,
  SupportCaseEventsResource,
  SupportCasesResource,
  SupportCustomersResource,
} from "./resources.ts"

import { SupportCaseOperations } from "./sqlite.ts"

const parts = [
  Part.resource(SupportCustomersResource),
  Part.resource(SupportAgentsResource),
  Part.resource(SupportCasesResource),
  Part.resource(SupportCaseEventsResource),
  Part.command(SupportCaseOperations),
]

const supportCases = Application.define({ name: "support-cases", parts })

export const SupportCasesApplication = Application.compile(supportCases)
