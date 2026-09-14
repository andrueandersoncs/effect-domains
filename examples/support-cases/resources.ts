import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"

import {
  SupportAgentSchema,
  SupportCaseEventSchema,
  SupportCaseSchema,
  SupportCaseTransitions,
  SupportCustomerSchema,
} from "./domain.ts"

const mutableResourceCapabilities = [...Resource.crud(), Resource.patch()]

export const SupportCustomersResource = Resource.define({
  name: "support_customers",
  schema: SupportCustomerSchema,
  authorization: Authorization.public,
  capabilities: mutableResourceCapabilities,
})

export const SupportAgentsResource = Resource.define({
  name: "support_agents",
  schema: SupportAgentSchema,
  authorization: Authorization.public,
  capabilities: mutableResourceCapabilities,
})

const CustomerIdReference = Resource.reference(SupportCustomersResource, ["id"])
const AgentIdReference = Resource.reference(SupportAgentsResource, ["id"])


const supportCaseCreateSources = {
  priority: Resource.default("normal"),
  status: Resource.default("open"),
  openedAt: Resource.generated("now"),
}

const supportCaseCapabilities = [
  Resource.get(),
  Resource.list({
    filter: ["customerId", "priority", "status", "assignedAgentId"],
    range: ["openedAt"],
    order: [["openedAt", "desc"]],
    limit: 50,
  }),
  Resource.create({
    sources: supportCaseCreateSources,
    publish: false,
  }),
]

export const SupportCasesResource = Resource.define({
  name: "support_cases",
  schema: SupportCaseSchema,
  authorization: Authorization.public,
  version: "version",
  transitions: SupportCaseTransitions,
  capabilities: supportCaseCapabilities,
  relations: {
    foreignKeys: [
      { fields: ["customerId"], references: CustomerIdReference },
      { fields: ["assignedAgentId"], references: AgentIdReference },
    ],
    indexes: [
      { fields: ["customerId"] },
      { fields: ["priority", "status"] },
      { fields: ["assignedAgentId"] },
      { fields: ["openedAt"] },
    ],
  },
})

const CaseIdReference = Resource.reference(SupportCasesResource, ["id"])

const supportCaseEventCreateSources = { occurredAt: Resource.generated("now") }

const supportCaseEventCapabilities = [
  Resource.get(),
  Resource.list({
    filter: ["caseId", "kind", "agentId"],
    range: ["occurredAt"],
    order: [["occurredAt", "asc"]],
    limit: 100,
  }),
  Resource.create({
    sources: supportCaseEventCreateSources,
    publish: false,
  }),
]

export const SupportCaseEventsResource = Resource.define({
  name: "support_case_events",
  schema: SupportCaseEventSchema,
  authorization: Authorization.public,
  capabilities: supportCaseEventCapabilities,
  relations: {
    foreignKeys: [
      { fields: ["caseId"], references: CaseIdReference },
      { fields: ["agentId"], references: AgentIdReference },
    ],
    indexes: [
      { fields: ["caseId", "occurredAt"] },
      { fields: ["agentId"] },
    ],
  },
})
