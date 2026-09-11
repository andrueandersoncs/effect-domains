import { Schema, pipe } from "effect"

import {
  CalendarDateSchema,
  PositiveSafeIntSchema,
  UuidV7Schema,
  identifier,
} from "effect-domains/domain"

const validCurrency = Schema.isPattern(/^[A-Z]{3}$/)
export const CurrencySchema = Schema.String.check(validCurrency)

export const ExpenseCategorySchema = Schema.Literals([
  "meals",
  "travel",
  "software",
  "supplies",
  "other",
])

export const ExpenseIdSchema = pipe(UuidV7Schema, identifier)

export const ExpenseSchema = Schema.Struct({
  date: CalendarDateSchema,
  merchant: Schema.NonEmptyString,
  category: ExpenseCategorySchema,
  amountMinor: PositiveSafeIntSchema,
  currency: CurrencySchema,
})

export interface Expense extends Schema.Schema.Type<typeof ExpenseSchema> {}

export const ExpenseIdentifierInputSchema = Schema.Struct({ id: ExpenseIdSchema })

export interface ExpenseIdentifierInput extends Schema.Schema.Type<
  typeof ExpenseIdentifierInputSchema
> {}

export const ExpenseQueryInputSchema = Schema.Struct({
  from: CalendarDateSchema,
  through: CalendarDateSchema,
  category: Schema.optionalKey(ExpenseCategorySchema),
})

export interface ExpenseQueryInput extends Schema.Schema.Type<
  typeof ExpenseQueryInputSchema
> {}

export const ExpenseTotalSchema = Schema.Struct({
  category: ExpenseCategorySchema,
  currency: CurrencySchema,
  totalMinor: PositiveSafeIntSchema,
})

export class ExpenseNotFound extends Schema.TaggedError<ExpenseNotFound>()(
  "ExpenseNotFound",
  { id: ExpenseIdSchema },
) {}

export class InvalidExpenseDateRange extends Schema.TaggedError<InvalidExpenseDateRange>()(
  "InvalidExpenseDateRange",
  { from: CalendarDateSchema, through: CalendarDateSchema },
) {}

export class ExpenseLedgerUnavailable extends Schema.TaggedError<ExpenseLedgerUnavailable>()(
  "ExpenseLedgerUnavailable",
  {},
) {}
