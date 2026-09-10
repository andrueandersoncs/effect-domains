import { ExampleSubjectSchema } from "@effect-domains/example-support/authentication"
import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { Schema } from "effect"
import { InvoiceSchema, OrderLineSchema, OrderSchema, TenantIdSchema } from "./domain.ts"

const BillingSubjectSchema = Schema.Struct({ ...ExampleSubjectSchema.fields, tenantId: TenantIdSchema })
const subjectPolicy = Authorization.subject(BillingSubjectSchema)
const authenticated = subjectPolicy.all()
const editor = subjectPolicy.includes(subjectPolicy.subject.roles, "editor")
const administrator = subjectPolicy.includes(subjectPolicy.subject.roles, "admin")
const canEdit = subjectPolicy.any(editor, administrator)
export const BillingReadAuthorization = subjectPolicy.policy(authenticated)
export const BillingWriteAuthorization = subjectPolicy.policy(canEdit)

const ordersPolicy = Authorization.for({ resource: OrderSchema, subject: ExampleSubjectSchema })
const orderTenant = ordersPolicy.eq(ordersPolicy.row.tenantId, ordersPolicy.subject.tenantId)

const linesPolicy = Authorization.for({ resource: OrderLineSchema, subject: ExampleSubjectSchema })
const lineTenant = linesPolicy.eq(linesPolicy.row.tenantId, linesPolicy.subject.tenantId)

const invoicesPolicy = Authorization.for({ resource: InvoiceSchema, subject: ExampleSubjectSchema })
const invoiceTenant = invoicesPolicy.eq(invoicesPolicy.row.tenantId, invoicesPolicy.subject.tenantId)
const ordersAuthorization = ordersPolicy.policy({ scope: orderTenant, allow: { read: orderTenant } })
const linesAuthorization = linesPolicy.policy({ scope: lineTenant, allow: { read: lineTenant } })
const invoicesAuthorization = invoicesPolicy.policy({ scope: invoiceTenant, allow: { read: invoiceTenant } })

export const OrdersResource = Resource.make({
  authorization: ordersAuthorization,
  name: "orders",
  schema: OrderSchema,
  operations: {
    get: true,
    list: { filter: ["number", "status"], limit: 100 },
  },
  relations: {
    unique: [
      { name: "orders_tenant_id_id_key", fields: ["tenantId", "id"] },
      { name: "orders_tenant_number_key", fields: ["tenantId", "number"] },
    ],
    indexes: [
      { name: "orders_tenant_status_idx", fields: ["tenantId", "status"] },
    ],
  },
})

export const OrderLinesResource = Resource.make({
  authorization: linesAuthorization,
  name: "order_lines",
  schema: OrderLineSchema,
  operations: {
    get: true,
    list: { filter: ["orderId"], limit: 500 },
  },
  relations: {
    unique: [
      { name: "order_lines_tenant_order_line_key", fields: ["tenantId", "orderId", "lineNumber"] },
    ],
    foreignKeys: [{
      name: "order_lines_order_fk",
      fields: ["tenantId", "orderId"],
      references: { table: "orders", fields: ["tenantId", "id"] },
    }],
  },
})

export const InvoicesResource = Resource.make({
  authorization: invoicesAuthorization,
  name: "invoices",
  schema: InvoiceSchema,
  operations: {
    get: true,
    list: { filter: ["orderId", "number", "status"], limit: 100 },
  },
  relations: {
    unique: [
      { name: "invoices_tenant_id_id_key", fields: ["tenantId", "id"] },
      { name: "invoices_tenant_number_key", fields: ["tenantId", "number"] },
      { name: "invoices_tenant_order_key", fields: ["tenantId", "orderId"] },
    ],
    foreignKeys: [{
      name: "invoices_order_fk",
      fields: ["tenantId", "orderId"],
      references: { table: "orders", fields: ["tenantId", "id"] },
    }],
    indexes: [
      { name: "invoices_tenant_status_idx", fields: ["tenantId", "status"] },
    ],
  },
})
