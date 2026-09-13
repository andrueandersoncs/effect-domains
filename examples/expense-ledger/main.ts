import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { StaticSpa } from "effect-domains/static-spa"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExpenseLedgerApplication } from "./application.ts"
import { ExpenseLedgerMigrations } from "./migrations.ts"

const webBase = new URL("./web/", import.meta.url)

const webSite = StaticSpa.site({
  title: "Expense ledger",
  accent: "#1d4ed8",
  base: webBase,
})

const web = StaticSpa.layerHttp(webSite)

pipe(ApplicationBun.run(ExpenseLedgerApplication, {
  database: { migrations: ExpenseLedgerMigrations },
  admin: true,
  routes: web,
}), BunRuntime.runMain)
