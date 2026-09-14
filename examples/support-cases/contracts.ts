import { Schema } from "effect"
import { Resource } from "effect-domains/resource"

import {
  SupportAgentsResource,
  SupportCaseEventsResource,
  SupportCasesResource,
  SupportCustomersResource,
} from "./resources.ts"

const SupportAgentRowSchema = Schema.NullOr(Resource.table(SupportAgentsResource).rowSchema)
const SupportCaseEventsSchema = Schema.Array(Resource.table(SupportCaseEventsResource).rowSchema)

export class SupportCaseDetail extends Schema.Class<SupportCaseDetail>("SupportCaseDetail")({
  case: Resource.table(SupportCasesResource).rowSchema,
  customer: Resource.table(SupportCustomersResource).rowSchema,
  agent: SupportAgentRowSchema,
  events: SupportCaseEventsSchema,
}) {}
