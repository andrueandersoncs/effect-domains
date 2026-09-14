import { Application, Part } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { BillingOperations } from "./sqlite.ts"
import { InvoicesResource, OrderLinesResource, OrdersResource } from "./resources.ts"

const billingParts = [
  Part.resource(OrdersResource),
  Part.resource(OrderLinesResource),
  Part.resource(InvoicesResource),
  Part.command(BillingOperations),
]

const BillingDomain = Application.define({
  name: "billing",
  parts: billingParts,
})

const applicationParts = [
  Part.application(BillingDomain),
  Part.native(IdentityBundle),
]

const application = Application.define({
  name: "orders-invoices",
  parts: applicationParts,
})

export const BillingApplication = Application.compile(application)
