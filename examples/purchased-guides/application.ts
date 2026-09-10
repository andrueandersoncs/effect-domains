import { Application } from "effect-domains/application"
import { GuidePurchasesResource, GuidesResource } from "./resources.ts"

export const PurchasedGuidesApplication = Application.make({
  name: "purchased-guides",
  parts: [GuidesResource, GuidePurchasesResource],
})
