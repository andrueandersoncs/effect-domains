import { Application, Part } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { BillingOperations } from "./sqlite.ts"
import { InvoicesResource, OrderLinesResource, OrdersResource } from "./resources.ts"

export const BillingApplication = Application.compile(Application.define({
  name: "orders-invoices",
  parts: [
    Part.resource(OrdersResource),
    Part.resource(OrderLinesResource),
    Part.resource(InvoicesResource),
    Part.command(BillingOperations),
    Part.native(IdentityBundle),
  ],
}))
