import { Application } from "effect-domains/application"
import { IdentityHandlers, IdentityRpcs } from "effect-domains/identity-rpc"
import { GuidePurchasesResource, GuidesResource } from "./resources.ts"

export const PurchasedGuidesApplication = Application.make({
  name: "purchased-guides",
  parts: [GuidesResource, GuidePurchasesResource, { group: IdentityRpcs, handlers: IdentityHandlers }],
})
