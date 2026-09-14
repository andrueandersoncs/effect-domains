import { Schema } from "effect"
import { Resource } from "effect-domains/resource"
import { InvoicesResource, OrderLinesResource, OrdersResource } from "./resources.ts"

const orderLinesSchema = Schema.Array(Resource.table(OrderLinesResource).rowSchema)
const orderInvoiceSchema = Schema.NullOr(Resource.table(InvoicesResource).rowSchema)

export class OrderSummary extends Schema.Class<OrderSummary>("OrderSummary")({
  order: Resource.table(OrdersResource).rowSchema,
  lines: orderLinesSchema,
  invoice: orderInvoiceSchema,
}) {}
