import { pipe } from "effect"
import { StaticSpa } from "effect-domains/static-spa"
import { ApplicationBun } from "effect-domains/application-bun"
import { RepairWorkshopApplication } from "./application.ts"
import { RepairWorkshopMigrations } from "./migrations.ts"

const webBase = new URL("./web/", import.meta.url)
const web = StaticSpa.layerHttp({ title: "Repair workshop", accent: "#b45309", base: webBase })

const program = ApplicationBun.run(RepairWorkshopApplication, {
  database: { migrations: RepairWorkshopMigrations },
  admin: true,
  routes: web,
})

pipe(program, ApplicationBun.runMain)
