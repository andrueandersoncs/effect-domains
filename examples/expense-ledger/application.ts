import { Application, Part } from "effect-domains/application"
import { ExpensesResource } from "./resources.ts"
import { ExpenseLedgerOperations } from "./sqlite.ts"

export const ExpenseLedgerApplication = Application.compile(Application.define({
  name: "expense-ledger",
  parts: [Part.resource(ExpensesResource), Part.command(ExpenseLedgerOperations)],
}))
