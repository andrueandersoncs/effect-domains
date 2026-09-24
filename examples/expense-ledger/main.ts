import { Effect, pipe } from "effect"
import * as ApplicationBun from "effect-domains/application-bun"
import { ExpenseLedgerApplication } from "./application.ts"
import { ExpenseLedgerMigrations } from "./migrations.ts"


const program = ApplicationBun.runApplication(ExpenseLedgerApplication, {
  database: { migrations: ExpenseLedgerMigrations },
  ui: {
    presentation: {
      title: "Expense ledger",
      description: "Record business expenses and review totals by category and currency.",
    },
  },
})

pipe(program, ApplicationBun.runMain, Effect.runSync)
