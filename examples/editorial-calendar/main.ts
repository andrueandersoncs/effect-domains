import { pipe } from "effect"
import { StaticSpa } from "effect-domains/static-spa"
import { ApplicationBun } from "effect-domains/application-bun"
import { EditorialCalendarApplication } from "./application.ts"
import { EditorialCalendarMigrations } from "./migrations.ts"

const webBase = new URL("./web/", import.meta.url)
const web = StaticSpa.layerHttp({ title: "Editorial calendar", accent: "#6d28d9", base: webBase })

const program = ApplicationBun.run(EditorialCalendarApplication, {
  database: { migrations: EditorialCalendarMigrations },
  admin: true,
  routes: web,
})

pipe(program, ApplicationBun.runMain)
