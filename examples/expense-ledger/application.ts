import { Application, Part } from "effect-domains/application"
import { ExpensesResource } from "./resources.ts"
import { ExpenseLedgerOperations } from "./sqlite.ts"
import { Effect } from "effect"

const parts = [Part.resource(ExpensesResource), Part.command(ExpenseLedgerOperations)]
const expenseLedger = Application.define({ name: "expense-ledger", parts })
const expenseLedgerCompiler = Application.compile(expenseLedger)
const expenseLedgerApplication = Effect.runSync(expenseLedgerCompiler)

export { expenseLedgerApplication as ExpenseLedgerApplication }
