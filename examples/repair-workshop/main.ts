import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { StaticSpa } from "effect-domains/static-spa"
import { ApplicationBun } from "effect-domains/application-bun"
import { RepairWorkshopApplication } from "./application.ts"
import { RepairWorkshopMigrations } from "./migrations.ts"

const webBase = new URL("./web/", import.meta.url)

const webSite = StaticSpa.site({
  title: "Repair workshop",
  accent: "#b45309",
  base: webBase,
})

const web = StaticSpa.layerHttp(webSite)

pipe(ApplicationBun.run(RepairWorkshopApplication, {
  database: { migrations: RepairWorkshopMigrations },
  admin: true,
  routes: web,
}), BunRuntime.runMain)
