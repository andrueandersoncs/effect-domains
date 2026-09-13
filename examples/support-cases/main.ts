import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { StaticSpa } from "effect-domains/static-spa"
import { SupportCasesApplication } from "./application.ts"
import { SupportCasesMigrations } from "./migrations.ts"

const webBase = new URL("./web/", import.meta.url)
const web = StaticSpa.layerHttp({ title: "Support cases", accent: "#0f766e", base: webBase })

const program = ApplicationBun.run(SupportCasesApplication, {
  database: { migrations: SupportCasesMigrations },
  admin: true,
  routes: web,
})

pipe(program, ApplicationBun.runMain)
