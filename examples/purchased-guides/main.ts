import { BunRuntime } from "@effect/platform-bun"
import { Layer, pipe } from "effect"
import { ExampleAuthentication } from "@effect-domains/example-support/authentication"
import { ApplicationBun } from "effect-domains/application-bun"
import { PurchasedGuidesApplication } from "./application.ts"
import { PurchasedGuideEntitlements, seedPurchasedGuides } from "./entitlements.ts"
import { PurchasedGuidesMigrations } from "./migrations.ts"

const services = Layer.mergeAll(ExampleAuthentication, PurchasedGuideEntitlements)
const initialize = seedPurchasedGuides()

pipe(ApplicationBun.run(PurchasedGuidesApplication, {
  database: { migrations: PurchasedGuidesMigrations },
  services,
  initialize,
}), BunRuntime.runMain)
