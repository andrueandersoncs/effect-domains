import { pipe } from "effect"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import * as ApplicationBun from "effect-domains/application-bun"
import { SupportCasesApplication } from "./application.ts"
import { SupportCasesMigrations } from "./migrations.ts"

const services = ExampleIdentity.layer("support-cases")


const ui = {
  presentation: {
    title: "Support cases",
    description: "Open, triage, assign, resolve, and reopen customer cases through declared operations.",
    resources: {
      support_customers: { label: "Customers", columns: ["id", "name"] },
      support_agents: { label: "Agents", columns: ["id", "name", "onDuty"] },
      support_cases: {
        label: "Cases",
        columns: [
          "id",
          "customerId",
          "subject",
          "priority",
          "status",
          "assignedAgentId",
          "openedAt",
          "version",
        ],
      },
      support_case_events: {
        label: "Case history",
        columns: ["id", "caseId", "kind", "agentId", "note", "occurredAt"],
      },
    },
    operations: {
      "support.openCase": {
        label: "Open case",
        description: "Create a case and its opening history entry in one transaction.",
      },
      "support.advanceCase": {
        label: "Advance case",
        description: "Apply a guarded lifecycle transition and append its history entry.",
      },
      "support.caseDetail": {
        label: "Case detail",
        description: "Read the case with its customer, assigned agent, and ordered history.",
      },
      "support.board": {
        label: "Case board",
        description: "List the joined board with filters, range bounds, and keyset pagination.",
      },
      "support.auditTrail": {
        label: "Audit trail",
        description: "Read durable application-owned lifecycle evidence as an administrator.",
      },
    },
  },
}

const program = ApplicationBun.runApplication(SupportCasesApplication, {
  database: { migrations: SupportCasesMigrations },
  services,
  ui,
  telemetry: {
    protocol: "http/protobuf",
    resource: {
      serviceName: "support-cases",
      attributes: { "service.namespace": "effect-domains.examples" },
    },
  },
})

pipe(program, ApplicationBun.runMain)
