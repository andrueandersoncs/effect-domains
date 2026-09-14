import { Application, Part } from "effect-domains/application"
import { ExpensesResource } from "./resources.ts"
import { ExpenseLedgerOperations } from "./sqlite.ts"

const parts = [Part.resource(ExpensesResource), Part.command(ExpenseLedgerOperations)]
const expenseLedger = Application.define({ name: "expense-ledger", parts })
export const ExpenseLedgerApplication = Application.compile(expenseLedger)
