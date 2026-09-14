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
  allow: { read: ExampleRoles.reader, create: ExampleRoles.editor, patch: ExampleRoles.editor, transition: ExampleRoles.editor },
})

export const OrdersResource = Resource.define({
  authorization: ordersAuthorization,
  name: "orders",
  schema: OrderSchema,
  version: "version",
  transitions: OrderTransitions,
  capabilities: Resource.capabilities(
    Resource.get(),
    Resource.list({ filter: ["number", "status"], limit: 100 }),
  ),
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

const OrderIdReference = Resource.reference(OrdersResource, ["id"])

export const OrderLinesResource = Resource.define({
  authorization: linesAuthorization,
  name: "order_lines",
  schema: OrderLineSchema,
  capabilities: Resource.capabilities(
    Resource.get(),
    Resource.list({ filter: ["orderId"], limit: 100 }),
  ),
  relations: {
    unique: [
      { fields: ["tenantId", "orderId", "lineNumber"] },
    ],
    foreignKeys: [{
      fields: ["orderId"],
      references: OrderIdReference,
      scope: ["tenantId"],
    }],
  },
})

const invoicesScope = invoicesPolicy.sameAs("tenantId")

const invoicesAuthorization = invoicesPolicy.policy({
  scope: invoicesScope,
  allow: { read: ExampleRoles.reader, create: ExampleRoles.editor, patch: ExampleRoles.editor, transition: ExampleRoles.editor },
})

export const InvoicesResource = Resource.define({
  authorization: invoicesAuthorization,
  name: "invoices",
  schema: InvoiceSchema,
  version: "version",
  transitions: InvoiceTransitions,
  capabilities: Resource.capabilities(
    Resource.get(),
    Resource.list({ filter: ["orderId", "number", "status"], limit: 100 }),
  ),
  relations: {
    unique: [
      { fields: ["tenantId", "id"] },
      { fields: ["tenantId", "number"] },
      { fields: ["tenantId", "orderId"] },
    ],
    foreignKeys: [{
      fields: ["orderId"],
      references: OrderIdReference,
      scope: ["tenantId"],
    }],
    indexes: [
      { fields: ["tenantId", "status"] },
    ],
  },
})
