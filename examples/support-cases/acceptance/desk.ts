import type { SurfaceDeclaration } from "@effect-domains/acceptance/surface"

const noteControl: SurfaceDeclaration["actions"][number]["controls"][number] = {
  name: "note",
  kind: "text",
  element: { locator: ".queue-item__note", semantics: { role: "textbox", name: "Note", attributes: { "data-field": "note" } } },
}

const agentControl: SurfaceDeclaration["actions"][number]["controls"][number] = {
  name: "agent",
  kind: "select",
  element: { locator: ".queue-item__assignee", semantics: { role: "combobox", name: "On-duty agent", attributes: { "data-field": "assignedAgentId" } } },
}

type Attributes = SurfaceDeclaration["refresh"]["semantics"]["attributes"]

const triageAttributes: Attributes = { "data-operation": "support.advanceCase", "data-transition": "triage" }

const assignAttributes: Attributes = { "data-operation": "support.advanceCase", "data-transition": "assign" }

const settled = "main[data-surface='support-desk'][data-state='ready'] [role='status'][data-outcome]"

/**
 * The support desk binding: rows are bound by their case identity attribute and rendered id column, every lifecycle command takes its
 * version from the rendered row, and only the presentation classes are locators because a refactor of the desk may rename them.
 */
export const deskBinding: SurfaceDeclaration = {
  id: "support-desk",
  title: "Support desk",
  path: "/desk",
  ready: "main[data-surface='support-desk'][data-state='ready']",
  source: "support.board",
  refresh: { locator: ".queue-toolbar__reload", semantics: { role: "button", name: "Refresh", attributes: { "data-operation": "support.board" } } },
  collection: {
    row: { locator: "tr.queue-item", semantics: { role: "row", attributes: {} } },
    identity: "data-case-id",
    identityColumn: "id",
    columns: [
      { column: "id", locator: "[data-column='id']", attribute: "data-value" },
      { column: "subject", locator: "[data-column='subject']", attribute: "data-value" },
      { column: "customerName", locator: "[data-column='customerName']", attribute: "data-value" },
      { column: "status", locator: "[data-column='status']", attribute: "data-value" },
      { column: "agentName", locator: "[data-column='agentName']", attribute: "data-value" },
      { column: "version", locator: "[data-column='version']", attribute: "data-value" },
    ],
  },
  actions: [
    {
      id: "triage",
      operation: "support.advanceCase",
      description: "Triage this case at its rendered version with the entered note",
      trigger: { locator: ".queue-item__command--triage", semantics: { role: "button", name: "Triage", attributes: triageAttributes } },
      controls: [noteControl],
      fields: {
        caseId: { from: "identity" },
        expectedVersion: { from: "column", name: "version" },
        action: { from: "literal", value: "triage" },
        note: { from: "control", name: "note" },
      },
      settle: settled,
    },
    {
      id: "assign",
      operation: "support.advanceCase",
      description: "Assign this case at its rendered version to the selected on-duty agent",
      trigger: { locator: ".queue-item__command--assign", semantics: { role: "button", name: "Assign", attributes: assignAttributes } },
      controls: [agentControl],
      fields: {
        caseId: { from: "identity" },
        expectedVersion: { from: "column", name: "version" },
        action: { from: "literal", value: "assign" },
        assignedAgentId: { from: "control", name: "agent" },
      },
      settle: settled,
    },
  ],
  scenarios: ["desk-triage-assign"],
  presentation: ["examples/support-cases/desk.ts", "examples/support-cases/acceptance/desk.ts"],
}
