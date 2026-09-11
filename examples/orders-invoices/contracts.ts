import { Schema } from "effect"
import { InvoicesResource, OrderLinesResource, OrdersResource } from "./resources.ts"

const orderLinesSchema = Schema.Array(OrderLinesResource.table.rowSchema)
const orderInvoiceSchema = Schema.NullOr(InvoicesResource.table.rowSchema)

export class OrderSummary extends Schema.Class<OrderSummary>("OrderSummary")({
  order: OrdersResource.table.rowSchema,
  lines: orderLinesSchema,
  invoice: orderInvoiceSchema,
}) {}
