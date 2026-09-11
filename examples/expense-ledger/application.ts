import { Application } from "effect-domains/application"
import { ExpensesResource } from "./resources.ts"
import { ExpenseLedgerOperations } from "./sqlite.ts"

export const ExpenseLedgerApplication = Application.make({
  name: "expense-ledger",
  parts: [ExpensesResource, ExpenseLedgerOperations],
})
