import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExpenseLedgerApplication } from "./application.ts"
import { ExpenseLedgerMigrations } from "./migrations.ts"


const program = ApplicationBun.run(ExpenseLedgerApplication, {
  database: { migrations: ExpenseLedgerMigrations },
  ui: {
    presentation: {
      title: "Expense ledger",
      description: "Record business expenses and review totals by category and currency.",
    },
  },
})

pipe(program, ApplicationBun.runMain)
