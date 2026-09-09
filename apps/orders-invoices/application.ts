import { Application } from "effect-domains/application"
import { Billing } from "./contracts.ts"
import { InvoicesResource, OrderLinesResource, OrdersResource } from "./resources.ts"

export const BillingApplication = Application.make({
  name: "orders-invoices",
  resources: [OrdersResource, OrderLinesResource, InvoicesResource],
  commands: [Billing],
})
