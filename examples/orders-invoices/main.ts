import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ExampleWeb } from "@effect-domains/example-web/serve"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { BillingApplication } from "./application.ts"
import { BillingMigrations } from "./migrations.ts"
import { BillingWebAssets } from "./web/assets.ts"

const web = ExampleWeb.layerHttp({
  title: "Orders and invoices",
  accent: "#1e40af",
  ...BillingWebAssets,
})

pipe(
  ApplicationBun.run(BillingApplication, {
    database: { migrations: BillingMigrations },
    services: ExampleIdentity,
    admin: true,
    routes: web,
  }),
  BunRuntime.runMain,
)
