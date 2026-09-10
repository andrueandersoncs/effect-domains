import { Application } from "effect-domains/application"
import { ExpenseLedgerRpcs } from "./contracts.ts"
import { ExpensesResource } from "./resources.ts"
import { ExpenseLedgerSqlite } from "./sqlite.ts"

export const ExpenseLedgerApplication = Application.make({
  name: "expense-ledger",
  parts: [ExpensesResource, { group: ExpenseLedgerRpcs, handlers: ExpenseLedgerSqlite }],
})
