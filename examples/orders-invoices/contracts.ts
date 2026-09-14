import { Schema } from "effect"
import { Resource } from "effect-domains/resource"
import { InvoicesResource, OrderLinesResource, OrdersResource } from "./resources.ts"

const orderLinesTable = Resource.table(OrderLinesResource)
const invoicesTable = Resource.table(InvoicesResource)
const ordersTable = Resource.table(OrdersResource)
const orderLinesSchema = Schema.Array(orderLinesTable.rowSchema)
const orderInvoiceSchema = Schema.NullOr(invoicesTable.rowSchema)

export class OrderSummary extends Schema.Class<OrderSummary>("OrderSummary")({
  order: ordersTable.rowSchema,
  lines: orderLinesSchema,
  invoice: orderInvoiceSchema,
}) {}
