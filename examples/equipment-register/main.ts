import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { StaticSpa } from "effect-domains/static-spa"
import { ApplicationBun } from "effect-domains/application-bun"
import { EquipmentRegisterApplication } from "./application.ts"
import { EquipmentRegisterMigrations } from "./migrations.ts"

const webBase = new URL("./web/", import.meta.url)

const webSite = StaticSpa.site({
  title: "Equipment register",
  accent: "#334155",
  base: webBase,
})

const web = StaticSpa.layerHttp(webSite)

pipe(ApplicationBun.run(EquipmentRegisterApplication, {
  database: { migrations: EquipmentRegisterMigrations },
  routes: web,
}), BunRuntime.runMain)
