import { pipe } from "effect"
import { StaticSpa } from "effect-domains/static-spa"
import { ApplicationBun } from "effect-domains/application-bun"
import { EquipmentRegisterApplication } from "./application.ts"
import { EquipmentRegisterMigrations } from "./migrations.ts"

const webBase = new URL("./web/", import.meta.url)
const web = StaticSpa.layerHttp({ title: "Equipment register", accent: "#334155", base: webBase })

const program = ApplicationBun.run(EquipmentRegisterApplication, {
  database: { migrations: EquipmentRegisterMigrations },
  routes: web,
})

pipe(program, ApplicationBun.runMain)
