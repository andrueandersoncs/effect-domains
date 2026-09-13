import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { Table } from "effect-domains/table"

import {
  SupportAgentSchema,
  SupportCaseEventSchema,
  SupportCaseSchema,
  SupportCaseTransitions,
  SupportCustomerSchema,
} from "./domain.ts"

export const SupportCustomersResource = Resource.make({
  name: "support_customers",
  schema: SupportCustomerSchema,
  authorization: Authorization.public,
  operations: { ...Resource.crud, patch: true },
})

export const SupportAgentsResource = Resource.make({
  name: "support_agents",
  schema: SupportAgentSchema,
  authorization: Authorization.public,
  operations: { ...Resource.crud, patch: true },
})

const CustomerIdReference = Table.reference(SupportCustomersResource.table, ["id"])
const AgentIdReference = Table.reference(SupportAgentsResource.table, ["id"])

export const SupportCasesResource = Resource.make({
  name: "support_cases",
  schema: SupportCaseSchema,
  authorization: Authorization.public,
  version: "version",
  transitions: SupportCaseTransitions,
  operations: {
    get: true,
    list: {
      filter: ["customerId", "priority", "status", "assignedAgentId"],
      range: ["openedAt"],
      order: [["openedAt", "desc"]],
      limit: 50,
    },
    create: {
      defaults: { priority: "normal", status: "open" },
      generated: { openedAt: "now" },
      publish: false,
    },
  },
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

const CaseIdReference = Table.reference(SupportCasesResource.table, ["id"])

export const SupportCaseEventsResource = Resource.make({
  name: "support_case_events",
  schema: SupportCaseEventSchema,
  authorization: Authorization.public,
  operations: {
    get: true,
    list: {
      filter: ["caseId", "kind", "agentId"],
      range: ["occurredAt"],
      order: [["occurredAt", "asc"]],
      limit: 100,
    },
    create: {
      generated: { occurredAt: "now" },
      publish: false,
    },
  },
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
