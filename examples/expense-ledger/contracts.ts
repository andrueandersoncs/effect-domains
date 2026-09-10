import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"

import {
  ExpenseIdentifierInputSchema,
  ExpenseLedgerUnavailable,
  ExpenseNotFound,
  ExpenseQueryInputSchema,
  ExpenseSchema,
  ExpenseTotalSchema,
  InvalidExpenseDateRange,
} from "./domain.ts"

import { ExpensesResource } from "./resources.ts"

const mutationErrorSchema = Schema.Union([
  ExpenseNotFound,
  ExpenseLedgerUnavailable,
])

const queryErrorSchema = Schema.Union([
  InvalidExpenseDateRange,
  ExpenseLedgerUnavailable,
])

const ExpenseRowsSchema = Schema.Array(ExpensesResource.table.rowSchema)
const ExpenseTotalsSchema = Schema.Array(ExpenseTotalSchema)

const recordExpense = Rpc.make("expenses.record", {
  payload: ExpenseSchema,
  success: ExpensesResource.table.rowSchema,
  error: ExpenseLedgerUnavailable,
})

const getExpense = Rpc.make("expenses.get", {
  payload: ExpenseIdentifierInputSchema,
  success: ExpensesResource.table.rowSchema,
  error: mutationErrorSchema,
})

const queryExpenses = Rpc.make("expenses.query", {
  payload: ExpenseQueryInputSchema,
  success: ExpenseRowsSchema,
  error: queryErrorSchema,
})

const expenseTotals = Rpc.make("expenses.totals", {
  payload: ExpenseQueryInputSchema,
  success: ExpenseTotalsSchema,
  error: queryErrorSchema,
})

const updateExpense = Rpc.make("expenses.update", {
  payload: ExpensesResource.table.rowSchema,
  success: ExpensesResource.table.rowSchema,
  error: mutationErrorSchema,
})

const removeExpense = Rpc.make("expenses.remove", {
  payload: ExpenseIdentifierInputSchema,
  success: ExpensesResource.table.rowSchema,
  error: mutationErrorSchema,
})

export const ExpenseLedgerRpcs = RpcGroup.make(
  recordExpense,
  getExpense,
  queryExpenses,
  expenseTotals,
  updateExpense,
  removeExpense,
)
