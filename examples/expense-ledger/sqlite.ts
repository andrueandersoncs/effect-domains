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
  ExpenseSchema,
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

const recordExpense = SqlSchema.findOne({
  Request: ExpenseSchema,
  Result: ExpensesResource.table.rowSchema,
  execute: Effect.fn("ExpenseLedger.record.implementation")(function* (expense) {
    const database = yield* SqlClient.SqlClient

    return yield* database<SqliteRow>`
      INSERT INTO ${database(ExpensesResource.table.name)} ${database.insert(expense)}
      RETURNING *
    `
  }),
})

const findExpense = SqlSchema.findOneOption({
  Request: ExpenseIdentifierInputSchema,
  Result: ExpensesResource.table.rowSchema,
  execute: Effect.fn("ExpenseLedger.get.implementation")(function* (input) {
    const database = yield* SqlClient.SqlClient

    return yield* database<SqliteRow>`
      SELECT * FROM ${database(ExpensesResource.table.name)}
      WHERE ${database(ExpensesResource.table.identifier)} = ${input.id}
      LIMIT 1
    `
  }),
})

const queryExpenses = SqlSchema.findAll({
  Request: ExpenseQueryInputSchema,
  Result: ExpensesResource.table.rowSchema,
  execute: Effect.fn("ExpenseLedger.query.implementation")(function* (input) {
    const database = yield* SqlClient.SqlClient
    const limit = input.limit ?? 50
    const category = Option.fromNullishOr(input.category)

    if (Option.isNone(category)) {
      return yield* database<SqliteRow>`
        SELECT * FROM ${database(ExpensesResource.table.name)}
        WHERE ${database("date")} >= ${input.from} AND ${database("date")} <= ${input.through}
        ORDER BY ${database("date")} ASC, ${database(ExpensesResource.table.identifier)} ASC
        LIMIT ${limit}
      `
    }

    return yield* database<SqliteRow>`
      SELECT * FROM ${database(ExpensesResource.table.name)}
      WHERE ${database("date")} >= ${input.from} AND ${database("date")} <= ${input.through}
        AND ${database("category")} = ${input.category}
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
    const category = Option.fromNullishOr(input.category)

    if (Option.isNone(category)) {
      return yield* database<SqliteRow>`
        SELECT ${database("category")}, ${database("currency")},
          SUM(${database("amountMinor")}) AS ${database("totalMinor")}
        FROM ${database(ExpensesResource.table.name)}
        WHERE ${database("date")} >= ${input.from} AND ${database("date")} <= ${input.through}
        GROUP BY ${database("category")}, ${database("currency")}
        ORDER BY ${database("category")} ASC, ${database("currency")} ASC
      `
    }

    return yield* database<SqliteRow>`
      SELECT ${database("category")}, ${database("currency")},
        SUM(${database("amountMinor")}) AS ${database("totalMinor")}
      FROM ${database(ExpensesResource.table.name)}
      WHERE ${database("date")} >= ${input.from} AND ${database("date")} <= ${input.through}
        AND ${database("category")} = ${input.category}
      GROUP BY ${database("category")}, ${database("currency")}
      ORDER BY ${database("category")} ASC, ${database("currency")} ASC
    `
  }),
})

const updateExpense = SqlSchema.findOneOption({
  Request: ExpensesResource.table.rowSchema,
  Result: ExpensesResource.table.rowSchema,
  execute: Effect.fn("ExpenseLedger.update.implementation")(function* (input) {
    const database = yield* SqlClient.SqlClient
    const changes = database.update(input, [ExpensesResource.table.identifier])

    return yield* database<SqliteRow>`
      UPDATE ${database(ExpensesResource.table.name)}
      SET ${changes}
      WHERE ${database(ExpensesResource.table.identifier)} = ${input.id}
      RETURNING *
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
  return yield* pipe(recordExpense(input), Effect.catchTags({
    ...persistenceFailures,
    NoSuchElementError: persistenceFailure,
  }))
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
  const found = yield* pipe(findExpense(input), Effect.catchTags(persistenceFailures))
  return yield* requireExpense(input.id, found)
})

const update = Effect.fn("ExpenseLedger.update")(function* (
  input: typeof ExpensesResource.table.rowSchema.Type,
) {
  const found = yield* pipe(updateExpense(input), Effect.catchTags(persistenceFailures))
  return yield* requireExpense(input.id, found)
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
