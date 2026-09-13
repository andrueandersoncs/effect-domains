import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { StaticSpa } from "effect-domains/static-spa"
import { ApplicationBun } from "effect-domains/application-bun"
import { EditorialCalendarApplication } from "./application.ts"
import { EditorialCalendarMigrations } from "./migrations.ts"

const webBase = new URL("./web/", import.meta.url)

const webSite = StaticSpa.site({
  title: "Editorial calendar",
  accent: "#6d28d9",
  base: webBase,
})

const web = StaticSpa.layerHttp(webSite)

pipe(ApplicationBun.run(EditorialCalendarApplication, {
  database: { migrations: EditorialCalendarMigrations },
  admin: true,
  routes: web,
}), BunRuntime.runMain)
