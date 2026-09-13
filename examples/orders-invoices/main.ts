import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { StaticSpa } from "effect-domains/static-spa"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { BillingApplication } from "./application.ts"
import { BillingMigrations } from "./migrations.ts"

const webBase = new URL("./web/", import.meta.url)

const webSite = StaticSpa.site({
  title: "Orders and invoices",
  accent: "#1e40af",
  base: webBase,
})

const web = StaticSpa.layerHttp(webSite)

const services = ExampleIdentity.layer("orders-invoices")

pipe(ApplicationBun.run(BillingApplication, {
  database: { migrations: BillingMigrations },
  services,
  admin: true,
  routes: web,
}), BunRuntime.runMain)
