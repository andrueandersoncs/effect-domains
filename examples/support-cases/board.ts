import { Schema } from "effect"
import { ReadModel } from "effect-domains/read-model"

import {
  SupportAgentsResource,
  SupportCasesResource,
  SupportCustomersResource,
} from "./resources.ts"

export const SupportCaseBoard = ReadModel.define({
  tables: ReadModel.sources({
    supportCase: SupportCasesResource,
    customer: SupportCustomersResource,
    agent: SupportAgentsResource,
  }),
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

export const SupportCaseBoardList = ReadModel.page({
  model: SupportCaseBoard,
  filter: ["customerId", "priority", "status", "assignedAgentId"],
  range: ["openedAt"],
  order: [["openedAt", "desc"], ["id", "asc"]],
  limit: 50,
})

export const SupportCaseBoardPage = ReadModel.compilePage(SupportCaseBoardList)
export const SupportCaseBoardRowSchema = Schema.toType(ReadModel.compile(SupportCaseBoard).schema)
