import { ExampleRoles, ExampleSubjectSchema } from "@effect-domains/example-support/subject"
import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { Transitions } from "effect-domains/transitions"
import { InvoiceSchema, InvoiceStatusSchema, OrderLineSchema, OrderSchema, OrderStatusSchema } from "./domain.ts"

export const OrderTransitions = Transitions.make({
  name: "Order",
  field: "status",
  status: OrderStatusSchema,
  transitions: {
    issueInvoice: { from: ["draft"], to: "invoiced" },
  },
})

export const InvoiceTransitions = Transitions.make({
  name: "Invoice",
  field: "status",
  status: InvoiceStatusSchema,
  transitions: {
    pay: { from: ["issued"], to: "paid" },
  },
})

const ordersPolicy = Authorization.for({ resource: OrderSchema, subject: ExampleSubjectSchema })
const linesPolicy = Authorization.for({ resource: OrderLineSchema, subject: ExampleSubjectSchema })
const invoicesPolicy = Authorization.for({ resource: InvoiceSchema, subject: ExampleSubjectSchema })

const ordersScope = ordersPolicy.sameAs("tenantId")

const ordersAuthorization = ordersPolicy.policy({
  scope: ordersScope,
  allow: { read: ExampleRoles.reader, create: ExampleRoles.editor, patch: ExampleRoles.editor },
})

export const OrdersResource = Resource.make({
  authorization: ordersAuthorization,
  name: "orders",
  schema: OrderSchema,
  version: "version",
  transitions: OrderTransitions,
  operations: {
    get: true,
    list: { filter: ["number", "status"], limit: 100 },
  },
  relations: {
    unique: [
      { fields: ["tenantId", "id"] },
      { fields: ["tenantId", "number"] },
    ],
    indexes: [
      { fields: ["tenantId", "status"] },
    ],
  },
})

const linesScope = linesPolicy.sameAs("tenantId")

const linesAuthorization = linesPolicy.policy({
  scope: linesScope,
  allow: { read: ExampleRoles.reader, create: ExampleRoles.editor },
})

export const OrderLinesResource = Resource.make({
  authorization: linesAuthorization,
  name: "order_lines",
  schema: OrderLineSchema,
  operations: {
    get: true,
    list: { filter: ["orderId"], limit: 100 },
  },
  relations: {
    unique: [
      { fields: ["tenantId", "orderId", "lineNumber"] },
    ],
    foreignKeys: [{
      fields: ["orderId"],
      references: { table: "orders", fields: ["id"] },
      scope: ["tenantId"],
    }],
  },
})

const invoicesScope = invoicesPolicy.sameAs("tenantId")

const invoicesAuthorization = invoicesPolicy.policy({
  scope: invoicesScope,
  allow: { read: ExampleRoles.reader, create: ExampleRoles.editor, patch: ExampleRoles.editor },
})

export const InvoicesResource = Resource.make({
  authorization: invoicesAuthorization,
  name: "invoices",
  schema: InvoiceSchema,
  version: "version",
  transitions: InvoiceTransitions,
  operations: {
    get: true,
    list: { filter: ["orderId", "number", "status"], limit: 100 },
  },
  relations: {
    unique: [
      { fields: ["tenantId", "id"] },
      { fields: ["tenantId", "number"] },
      { fields: ["tenantId", "orderId"] },
    ],
    foreignKeys: [{
      fields: ["orderId"],
      references: { table: "orders", fields: ["id"] },
      scope: ["tenantId"],
    }],
    indexes: [
      { fields: ["tenantId", "status"] },
    ],
  },
})
