import { Schema } from "effect"
import { Resource } from "effect-domains/resource"

import {
  SupportAgentsResource,
  SupportCaseEventsResource,
  SupportCasesResource,
  SupportCustomersResource,
} from "./resources.ts"

const supportAgentsTable = Resource.table(SupportAgentsResource)
const supportCaseEventsTable = Resource.table(SupportCaseEventsResource)
const supportCasesTable = Resource.table(SupportCasesResource)
const supportCustomersTable = Resource.table(SupportCustomersResource)
const SupportAgentRowSchema = Schema.NullOr(supportAgentsTable.rowSchema)
const SupportCaseEventsSchema = Schema.Array(supportCaseEventsTable.rowSchema)

export class SupportCaseDetail extends Schema.Class<SupportCaseDetail>("SupportCaseDetail")({
  case: supportCasesTable.rowSchema,
  customer: supportCustomersTable.rowSchema,
  agent: SupportAgentRowSchema,
  events: SupportCaseEventsSchema,
}) {}
