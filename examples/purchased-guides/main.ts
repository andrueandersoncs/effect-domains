import { BunRuntime } from "@effect/platform-bun"
import { Layer, pipe } from "effect"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { ExampleWeb } from "@effect-domains/example-web/serve"
import { ApplicationBun } from "effect-domains/application-bun"
import { PurchasedGuidesApplication } from "./application.ts"
import { PurchasedGuideEntitlements, seedPurchasedGuides } from "./entitlements.ts"
import { PurchasedGuidesMigrations } from "./migrations.ts"
import { PurchasedGuidesWebAssets } from "./web/assets.ts"

const services = Layer.mergeAll(ExampleIdentity, PurchasedGuideEntitlements)
const initialize = seedPurchasedGuides()

const web = ExampleWeb.layerHttp({
  title: "Purchased guides",
  accent: "#be185d",
  ...PurchasedGuidesWebAssets,
})

pipe(ApplicationBun.run(PurchasedGuidesApplication, {
  database: { migrations: PurchasedGuidesMigrations },
  services,
  initialize,
  routes: web,
}), BunRuntime.runMain)
