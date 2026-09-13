import { Application } from "effect-domains/application"

import {
  SupportAgentsResource,
  SupportCaseEventsResource,
  SupportCasesResource,
  SupportCustomersResource,
} from "./resources.ts"

import { SupportCaseOperations } from "./sqlite.ts"

export const SupportCasesApplication = Application.make({
  name: "support-cases",
  parts: [
    SupportCustomersResource,
    SupportAgentsResource,
    SupportCasesResource,
    SupportCaseEventsResource,
    SupportCaseOperations,
  ],
})
