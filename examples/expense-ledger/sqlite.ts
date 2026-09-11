import { Effect, Option, Schema, pipe } from "effect"

import { SqlClient, SqlSchema } from "effect/unstable/sql"

import { Operation } from "effect-domains/operation"
import { ResourceNotFound } from "effect-domains/repository-store"

import {
  type Expense,
  type ExpenseIdentifierInput,
  ExpenseIdentifierInputSchema,
  ExpenseLedgerUnavailable,
  ExpenseNotFound,
  type ExpenseQueryInput,
  ExpenseQueryInputSchema,
  ExpenseTotalSchema,
  ExpenseSchema,
  InvalidExpenseDateRange,
} from "./domain.ts"

import { ExpensesResource } from "./resources.ts"

type SqliteRow = Readonly<Record<string, unknown>>

const expenseDateRange = (
  database: SqlClient.SqlClient,
  input: ExpenseQueryInput,
) => database`${database("date")} >= ${input.from} AND ${database("date")} <= ${input.through}`

const expenseConditions = (
  database: SqlClient.SqlClient,
  input: ExpenseQueryInput,
) => {
  const dateRange = expenseDateRange(database, input)

  return pipe(
    Option.fromNullishOr(input.category),
    Option.match({
      onNone: () => [dateRange],
      onSome: (category) => [
        dateRange,
        database`${database("category")} = ${category}`,
      ],
    }),
  )
}

const calculateTotals = SqlSchema.findAll({
  Request: ExpenseQueryInputSchema,
  Result: ExpenseTotalSchema,
  execute: Effect.fn("ExpenseLedger.totals.implementation")(function* (input) {
    const database = yield* SqlClient.SqlClient
    const conditions = expenseConditions(database, input)

    return yield* database<SqliteRow>`
      SELECT ${database("category")}, ${database("currency")},
        SUM(${database("amountMinor")}) AS ${database("totalMinor")}
      FROM ${database(ExpensesResource.table.name)}
      WHERE ${database.and(conditions)}
      GROUP BY ${database("category")}, ${database("currency")}
      ORDER BY ${database("category")} ASC, ${database("currency")} ASC
    `
  }),
})

const validateDateRange = Effect.fn("ExpenseLedger.validateDateRange")(function* (
  input: ExpenseQueryInput,
) {
  if (input.from > input.through) {
    return yield* InvalidExpenseDateRange.make({
      from: input.from,
      through: input.through,
    })
  }
})

const expenseNotFound = (id: ExpenseIdentifierInput["id"]) =>
  ExpenseNotFound.make({ id })


const get = Effect.fn("ExpenseLedger.get")(function* (
  input: ExpenseIdentifierInput,
) {
  return yield* pipe(
    ExpensesResource.repository.get(input.id),
    Effect.catchTag("ResourceNotFound", () => expenseNotFound(input.id)),
  )
})

const totals = Effect.fn("ExpenseLedger.totals")(function* (
  input: ExpenseQueryInput,
) {
  yield* validateDateRange(input)
  return yield* calculateTotals(input)
})

const update = Effect.fn("ExpenseLedger.update")(function* (
  input: typeof ExpensesResource.table.rowSchema.Type,
) {
  return yield* pipe(
    ExpensesResource.repository.update(input),
    Effect.catchTag("ResourceNotFound", () => expenseNotFound(input.id)),
  )
})

const remove = Effect.fn("ExpenseLedger.remove")(function* (
  input: ExpenseIdentifierInput,
) {
  const expense = yield* get(input)
  yield* ExpensesResource.repository.remove(input.id)
  return expense
})

const expenseTotalsSuccessSchema = Schema.Array(ExpenseTotalSchema)

const expenseTotalsErrorSchema = Schema.Union([
  InvalidExpenseDateRange,
  ExpenseLedgerUnavailable,
])

const mutationErrorsSchema = Schema.Union([
  ExpenseNotFound,
  ExpenseLedgerUnavailable,
])

const recordExpense = Operation.make({
  name: "expenses.record",
  payload: ExpenseSchema,
  success: ExpensesResource.table.rowSchema,
  error: ExpenseLedgerUnavailable,
  unavailable: ExpenseLedgerUnavailable,
  handler: ExpensesResource.repository.create,
})

const getExpense = Operation.make({
  name: "expenses.get",
  payload: ExpenseIdentifierInputSchema,
  success: ExpensesResource.table.rowSchema,
  error: mutationErrorsSchema,
  unavailable: ExpenseLedgerUnavailable,
  handler: get,
})

const expenseTotals = Operation.make({
  name: "expenses.totals",
  payload: ExpenseQueryInputSchema,
  success: expenseTotalsSuccessSchema,
  error: expenseTotalsErrorSchema,
  unavailable: ExpenseLedgerUnavailable,
  handler: totals,
})

const updateExpense = Operation.make({
  name: "expenses.update",
  payload: ExpensesResource.table.rowSchema,
  success: ExpensesResource.table.rowSchema,
  error: mutationErrorsSchema,
  unavailable: ExpenseLedgerUnavailable,
  handler: update,
})

const removeExpense = Operation.make({
  name: "expenses.remove",
  payload: ExpenseIdentifierInputSchema,
  success: ExpensesResource.table.rowSchema,
  error: mutationErrorsSchema,
  unavailable: ExpenseLedgerUnavailable,
  handler: remove,
})

export const ExpenseLedgerOperations = Operation.bundle(
  recordExpense,
  getExpense,
  expenseTotals,
  updateExpense,
  removeExpense,
)
