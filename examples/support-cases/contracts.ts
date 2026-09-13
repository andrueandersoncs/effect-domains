import { Schema } from "effect"

import {
  SupportAgentsResource,
  SupportCaseEventsResource,
  SupportCasesResource,
  SupportCustomersResource,
} from "./resources.ts"

const SupportAgentRowSchema = Schema.NullOr(SupportAgentsResource.table.rowSchema)
const SupportCaseEventsSchema = Schema.Array(SupportCaseEventsResource.table.rowSchema)

export class SupportCaseDetail extends Schema.Class<SupportCaseDetail>("SupportCaseDetail")({
  case: SupportCasesResource.table.rowSchema,
  customer: SupportCustomersResource.table.rowSchema,
  agent: SupportAgentRowSchema,
  events: SupportCaseEventsSchema,
}) {}
