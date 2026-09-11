import { BunRuntime } from "@effect/platform-bun"
import { Layer, pipe } from "effect"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { ExampleWeb } from "@effect-domains/example-web/serve"
import { ApplicationBun } from "effect-domains/application-bun"
import { PurchasedGuidesApplication } from "./application.ts"
import { PurchasedGuideEntitlements, seedPurchasedGuides } from "./entitlements.ts"
import { PurchasedGuidesMigrations } from "./migrations.ts"
import { PurchasedGuidesWebAssets } from "./web/assets.ts"

const identity = ExampleIdentity.layer("purchased-guides")
const services = Layer.mergeAll(identity, PurchasedGuideEntitlements)

const web = ExampleWeb.layerHttp({
  title: "Purchased guides",
  accent: "#be185d",
  ...PurchasedGuidesWebAssets,
})

const initialize = seedPurchasedGuides()

pipe(ApplicationBun.run(PurchasedGuidesApplication, {
  database: { migrations: PurchasedGuidesMigrations },
  services,
  initialize,
  routes: web,
}), BunRuntime.runMain)
