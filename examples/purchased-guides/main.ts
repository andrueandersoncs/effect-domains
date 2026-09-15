import { Layer, pipe } from "effect"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { ApplicationBun } from "effect-domains/application-bun"
import { PurchasedGuidesApplication } from "./application.ts"
import { PurchasedGuideEntitlements, seedPurchasedGuides } from "./entitlements.ts"
import { PurchasedGuidesMigrations } from "./migrations.ts"

const identity = ExampleIdentity.layer("purchased-guides")
const services = Layer.mergeAll(identity, PurchasedGuideEntitlements)


const initialize = seedPurchasedGuides()

const program = ApplicationBun.run(PurchasedGuidesApplication, {
  database: { migrations: PurchasedGuidesMigrations },
  services,
  initialize,
  ui: {
    presentation: {
      title: "Purchased guides",
      description: "Read guides granted to the authenticated account through declared entitlements.",
    },
  },
})

pipe(program, ApplicationBun.runMain)
