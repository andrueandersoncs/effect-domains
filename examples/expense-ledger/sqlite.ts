import { Effect, Option, Schema, pipe } from "effect"

import { SqlClient, SqlSchema } from "effect/unstable/sql"

import { Command } from "effect-domains/command"
import type { StructValue } from "effect-domains/domain"
import { ResourceNotFound } from "effect-domains/repository-store"
import { Resource } from "effect-domains/resource"

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

const expensesTable = Resource.table(ExpensesResource)
const expensesRepository = Resource.repository(ExpensesResource)


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

    return yield* database<StructValue>`
      SELECT ${database("category")}, ${database("currency")},
        SUM(${database("amountMinor")}) AS ${database("totalMinor")}
      FROM ${database(expensesTable.name)}
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
    expensesRepository.get(input.id),
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
  input: typeof expensesTable.rowSchema.Type,
) {
  return yield* pipe(
    expensesRepository.update(input),
    Effect.catchTag("ResourceNotFound", () => expenseNotFound(input.id)),
  )
})

const remove = Effect.fn("ExpenseLedger.remove")(function* (
  input: ExpenseIdentifierInput,
) {
  const expense = yield* get(input)

  yield* expensesRepository.remove(input.id)

  return expense
})

const expenseTotalsSuccessSchema = Schema.Array(ExpenseTotalSchema)

const ExpenseCommand = Command.family("expenses.", ExpenseLedgerUnavailable)

const recordExpenseSpec = ExpenseCommand.define({
  name: "record",
  payload: ExpenseSchema,
  success: expensesTable.rowSchema,
  dependencies: [ExpensesResource],
})

const recordExpense = Command.implement(
  recordExpenseSpec,
  expensesRepository.create,
)

const getExpenseSpec = ExpenseCommand.define({
  name: "get",
  payload: ExpenseIdentifierInputSchema,
  success: expensesTable.rowSchema,
  errors: ExpenseNotFound,
  dependencies: [ExpensesResource],
})

const getExpense = Command.implement(getExpenseSpec, get)

const expenseTotalsSpec = ExpenseCommand.define({
  name: "totals",
  payload: ExpenseQueryInputSchema,
  success: expenseTotalsSuccessSchema,
  errors: InvalidExpenseDateRange,
  dependencies: [ExpensesResource],
})

const expenseTotals = Command.implement(expenseTotalsSpec, totals)

const updateExpenseSpec = ExpenseCommand.define({
  name: "update",
  payload: expensesTable.rowSchema,
  success: expensesTable.rowSchema,
  errors: ExpenseNotFound,
  dependencies: [ExpensesResource],
})

const updateExpense = Command.implement(updateExpenseSpec, update)

const removeExpenseSpec = ExpenseCommand.define({
  name: "remove",
  payload: ExpenseIdentifierInputSchema,
  success: expensesTable.rowSchema,
  errors: ExpenseNotFound,
  dependencies: [ExpensesResource],
})

const removeExpense = Command.implement(removeExpenseSpec, remove)

export const ExpenseLedgerOperations = Command.bundle(
  recordExpense,
  getExpense,
  expenseTotals,
  updateExpense,
  removeExpense,
)
