import { Application } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { BillingOperations } from "./sqlite.ts"
import { InvoicesResource, OrderLinesResource, OrdersResource } from "./resources.ts"

export const BillingApplication = Application.make({
  name: "orders-invoices",
  parts: [OrdersResource, OrderLinesResource, InvoicesResource, BillingOperations, IdentityBundle],
})
