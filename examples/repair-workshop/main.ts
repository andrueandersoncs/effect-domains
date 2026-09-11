import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ExampleWeb } from "@effect-domains/example-web/serve"
import { ApplicationBun } from "effect-domains/application-bun"
import { RepairWorkshopApplication } from "./application.ts"
import { RepairWorkshopMigrations } from "./migrations.ts"
import { RepairWorkshopWebAssets } from "./web/assets.ts"

const web = ExampleWeb.layerHttp({
  title: "Repair workshop",
  accent: "#b45309",
  ...RepairWorkshopWebAssets,
})

pipe(ApplicationBun.run(RepairWorkshopApplication, {
  database: { migrations: RepairWorkshopMigrations },
  admin: true,
  routes: web,
}), BunRuntime.runMain)
