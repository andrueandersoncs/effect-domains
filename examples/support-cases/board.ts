import { Schema } from "effect"
import { SqliteView } from "effect-domains/sqlite-view"

import {
  SupportAgentsResource,
  SupportCasesResource,
  SupportCustomersResource,
} from "./resources.ts"

export const SupportCaseBoard = SqliteView.make({
  tables: {
    supportCase: SupportCasesResource.table,
    customer: SupportCustomersResource.table,
    agent: SupportAgentsResource.table,
  },
  from: "supportCase",
  joins: [
    {
      kind: "inner",
      table: "customer",
      on: [{ left: ["supportCase", "customerId"], right: ["customer", "id"] }],
    },
    {
      kind: "left",
      table: "agent",
      on: [{ left: ["supportCase", "assignedAgentId"], right: ["agent", "id"] }],
    },
  ],
  select: {
    id: ["supportCase", "id"],
    customerId: ["supportCase", "customerId"],
    customerName: ["customer", "name"],
    subject: ["supportCase", "subject"],
    priority: ["supportCase", "priority"],
    status: ["supportCase", "status"],
    assignedAgentId: ["supportCase", "assignedAgentId"],
    agentName: ["agent", "name"],
    agentOnDuty: ["agent", "onDuty"],
    openedAt: ["supportCase", "openedAt"],
    version: ["supportCase", "version"],
  },
})

export const SupportCaseBoardList = SqliteView.list({
  view: SupportCaseBoard,
  filter: ["customerId", "priority", "status", "assignedAgentId"],
  range: ["openedAt"],
  order: [["openedAt", "desc"], ["id", "asc"]],
  limit: 50,
})

export const SupportCaseBoardRowSchema = Schema.toType(SupportCaseBoard.schema)
