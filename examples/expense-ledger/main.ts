import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ExampleWeb } from "@effect-domains/example-web/serve"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExpenseLedgerApplication } from "./application.ts"
import { ExpenseLedgerMigrations } from "./migrations.ts"
import { ExpenseLedgerWebAssets } from "./web/assets.ts"

const web = ExampleWeb.layerHttp({
  title: "Expense ledger",
  accent: "#1d4ed8",
  ...ExpenseLedgerWebAssets,
})

pipe(ApplicationBun.run(ExpenseLedgerApplication, {
  database: { migrations: ExpenseLedgerMigrations },
  admin: true,
  routes: web,
}), BunRuntime.runMain)
