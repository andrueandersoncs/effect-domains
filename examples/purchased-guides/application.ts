import { Application, Part } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { GuidePurchasesResource, GuidesResource } from "./resources.ts"

export const PurchasedGuidesApplication = Application.compile(Application.define({
  name: "purchased-guides",
  parts: [Part.resource(GuidesResource), Part.resource(GuidePurchasesResource), Part.native(IdentityBundle)],
}))
