import { pipe } from "effect"
import { StaticSpa } from "effect-domains/static-spa"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExpenseLedgerApplication } from "./application.ts"
import { ExpenseLedgerMigrations } from "./migrations.ts"

const webBase = new URL("./web/", import.meta.url)
const web = StaticSpa.layerHttp({ title: "Expense ledger", accent: "#1d4ed8", base: webBase })

const program = ApplicationBun.run(ExpenseLedgerApplication, {
  database: { migrations: ExpenseLedgerMigrations },
  admin: true,
  routes: web,
})

pipe(program, ApplicationBun.runMain)
