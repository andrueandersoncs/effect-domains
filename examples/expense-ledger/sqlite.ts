import { Effect, Option, pipe } from "effect"
import { SqlClient, SqlSchema } from "effect/unstable/sql"
import { ExpenseLedgerRpcs } from "./contracts.ts"

import {
  type Expense,
  type ExpenseIdentifierInput,
  type ExpenseQueryInput,
  ExpenseIdentifierInputSchema,
  ExpenseLedgerUnavailable,
  ExpenseNotFound,
  ExpenseQueryInputSchema,
  ExpenseTotalSchema,
  InvalidExpenseDateRange,
} from "./domain.ts"

import { ExpensesResource } from "./resources.ts"

type SqliteRow = Readonly<Record<string, unknown>>

const persistenceFailure = Effect.fn("ExpenseLedger.persistenceFailure")(function* () {
  return yield* ExpenseLedgerUnavailable.make({})
})

const persistenceFailures = {
  SqlError: persistenceFailure,
  SchemaError: persistenceFailure,
}

const expenseDateRange = (database: SqlClient.SqlClient, input: ExpenseQueryInput) =>
  database`${database("date")} >= ${input.from} AND ${database("date")} <= ${input.through}`

const expenseConditions = (database: SqlClient.SqlClient, input: ExpenseQueryInput) => {
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

const queryExpenses = SqlSchema.findAll({
  Request: ExpenseQueryInputSchema,
  Result: ExpensesResource.table.rowSchema,
  execute: Effect.fn("ExpenseLedger.query.implementation")(function* (input) {
    const database = yield* SqlClient.SqlClient
    const limit = input.limit ?? 50
    const conditions = expenseConditions(database, input)

    return yield* database<SqliteRow>`
      SELECT * FROM ${database(ExpensesResource.table.name)}
      WHERE ${database.and(conditions)}
      ORDER BY ${database("date")} ASC, ${database(ExpensesResource.table.identifier)} ASC
      LIMIT ${limit}
    `
  }),
})

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

const removeExpense = SqlSchema.findOneOption({
  Request: ExpenseIdentifierInputSchema,
  Result: ExpensesResource.table.rowSchema,
  execute: Effect.fn("ExpenseLedger.remove.implementation")(function* (input) {
    const database = yield* SqlClient.SqlClient

    return yield* database<SqliteRow>`
      DELETE FROM ${database(ExpensesResource.table.name)}
      WHERE ${database(ExpensesResource.table.identifier)} = ${input.id}
      RETURNING *
    `
  }),
})

const requireExpense = Effect.fn("ExpenseLedger.require")(function* (
  id: (typeof ExpenseIdentifierInputSchema.Type)["id"],
  expense: Option.Option<typeof ExpensesResource.table.rowSchema.Type>,
) {
  if (Option.isNone(expense)) {
    return yield* ExpenseNotFound.make({ id })
  }

  return expense.value
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

const record = Effect.fn("ExpenseLedger.record")(function* (input: Expense) {
  return yield* pipe(
    ExpensesResource.repository.create(input),
    Effect.catchTag("RepositoryError", persistenceFailure),
  )
})

const query = Effect.fn("ExpenseLedger.query")(function* (input: ExpenseQueryInput) {
  yield* validateDateRange(input)
  return yield* pipe(queryExpenses(input), Effect.catchTags(persistenceFailures))
})

const totals = Effect.fn("ExpenseLedger.totals")(function* (input: ExpenseQueryInput) {
  yield* validateDateRange(input)
  return yield* pipe(calculateTotals(input), Effect.catchTags(persistenceFailures))
})

const get = Effect.fn("ExpenseLedger.get")(function* (input: ExpenseIdentifierInput) {

  const found = yield* pipe(
    ExpensesResource.repository.find(input.id),
    Effect.catchTag("RepositoryError", persistenceFailure),
  )

  return yield* requireExpense(input.id, found)
})

const update = Effect.fn("ExpenseLedger.update")(function* (
  input: typeof ExpensesResource.table.rowSchema.Type,
) {
  return yield* pipe(
    ExpensesResource.repository.update(input),
    Effect.catchTags({
      RepositoryError: persistenceFailure,
      ResourceNotFound: () => ExpenseNotFound.make({ id: input.id }),
    }),
  )
})

const remove = Effect.fn("ExpenseLedger.remove")(function* (input: ExpenseIdentifierInput) {
  const found = yield* pipe(removeExpense(input), Effect.catchTags(persistenceFailures))
  return yield* requireExpense(input.id, found)
})

export const ExpenseLedgerSqlite = ExpenseLedgerRpcs.toLayer({
  "expenses.record": record,
  "expenses.get": get,
  "expenses.query": query,
  "expenses.totals": totals,
  "expenses.update": update,
  "expenses.remove": remove,
})
