import { Application } from "effect-domains/application"
import { BillingRpcs } from "./contracts.ts"
import { BillingSqlite } from "./sqlite.ts"
import { InvoicesResource, OrderLinesResource, OrdersResource } from "./resources.ts"

export const BillingApplication = Application.make({
  name: "orders-invoices",
  resources: [OrdersResource, OrderLinesResource, InvoicesResource],
  commands: [{ group: BillingRpcs, handlers: BillingSqlite }],
})
