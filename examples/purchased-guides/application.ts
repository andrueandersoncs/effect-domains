import { Application, Part } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { GuidePurchasesResource, GuidesResource } from "./resources.ts"
import { Effect } from "effect"

const parts = [Part.resource(GuidesResource), Part.resource(GuidePurchasesResource), Part.native(IdentityBundle)]
const purchasedGuides = Application.define({ name: "purchased-guides", parts })
export const PurchasedGuidesApplication = Effect.runSync(Application.compile(purchasedGuides))
