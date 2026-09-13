import { BunRuntime } from "@effect/platform-bun"
import { Layer, pipe } from "effect"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { StaticSpa } from "effect-domains/static-spa"
import { ApplicationBun } from "effect-domains/application-bun"
import { PurchasedGuidesApplication } from "./application.ts"
import { PurchasedGuideEntitlements, seedPurchasedGuides } from "./entitlements.ts"
import { PurchasedGuidesMigrations } from "./migrations.ts"

const identity = ExampleIdentity.layer("purchased-guides")
const services = Layer.mergeAll(identity, PurchasedGuideEntitlements)

const webBase = new URL("./web/", import.meta.url)

const webSite = StaticSpa.site({
  title: "Purchased guides",
  accent: "#be185d",
  base: webBase,
})

const web = StaticSpa.layerHttp(webSite)

const initialize = seedPurchasedGuides()

pipe(ApplicationBun.run(PurchasedGuidesApplication, {
  database: { migrations: PurchasedGuidesMigrations },
  services,
  initialize,
  routes: web,
}), BunRuntime.runMain)
