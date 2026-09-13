import { pipe } from "effect"
import { StaticSpa } from "effect-domains/static-spa"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { BillingApplication } from "./application.ts"
import { BillingMigrations } from "./migrations.ts"

const webBase = new URL("./web/", import.meta.url)
const web = StaticSpa.layerHttp({ title: "Orders and invoices", accent: "#1e40af", base: webBase })

const services = ExampleIdentity.layer("orders-invoices")

const program = ApplicationBun.run(BillingApplication, {
  database: { migrations: BillingMigrations },
  services,
  admin: true,
  routes: web,
})

pipe(program, ApplicationBun.runMain)
