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

const ExpenseOperations = Operation.family("expenses.", ExpenseLedgerUnavailable)

const recordExpense = ExpenseOperations.make({
  name: "record",
  payload: ExpenseSchema,
  success: ExpensesResource.table.rowSchema,
  handler: ExpensesResource.repository.create,
})

const getExpense = ExpenseOperations.make({
  name: "get",
  payload: ExpenseIdentifierInputSchema,
  success: ExpensesResource.table.rowSchema,
  errors: ExpenseNotFound,
  handler: get,
})

const expenseTotals = ExpenseOperations.make({
  name: "totals",
  payload: ExpenseQueryInputSchema,
  success: expenseTotalsSuccessSchema,
  errors: InvalidExpenseDateRange,
  handler: totals,
})

const updateExpense = ExpenseOperations.make({
  name: "update",
  payload: ExpensesResource.table.rowSchema,
  success: ExpensesResource.table.rowSchema,
  errors: ExpenseNotFound,
  handler: update,
})

const removeExpense = ExpenseOperations.make({
  name: "remove",
  payload: ExpenseIdentifierInputSchema,
  success: ExpensesResource.table.rowSchema,
  errors: ExpenseNotFound,
  handler: remove,
})

export const ExpenseLedgerOperations = Operation.bundle(
  recordExpense,
  getExpense,
  expenseTotals,
  updateExpense,
  removeExpense,
)
