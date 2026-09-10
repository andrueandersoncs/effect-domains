import { Schema } from "effect"
import { CalendarDateSchema } from "effect-domains/domain"

const validCurrency = Schema.isPattern(/^[A-Z]{3}$/)
const atLeastOne = Schema.isGreaterThanOrEqualTo(1)
const atMostSafeInteger = Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
const atMostOneHundred = Schema.isLessThanOrEqualTo(100)
export const CurrencySchema = Schema.String.check(validCurrency)

export const ExpenseCategorySchema = Schema.Literals([
  "meals",
  "travel",
  "software",
  "supplies",
  "other",
])

export const PositiveMinorUnitsSchema = Schema.Int.check(atLeastOne, atMostSafeInteger)
export const QueryLimitSchema = Schema.Int.check(atLeastOne, atMostOneHundred)
export const ExpenseIdSchema = Schema.String.check(Schema.isUUID(7))

export const ExpenseSchema = Schema.Struct({
  date: CalendarDateSchema,
  merchant: Schema.NonEmptyString,
  category: ExpenseCategorySchema,
  amountMinor: PositiveMinorUnitsSchema,
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
  limit: Schema.optionalKey(QueryLimitSchema),
})

export interface ExpenseQueryInput extends Schema.Schema.Type<
  typeof ExpenseQueryInputSchema
> {}

export const ExpenseTotalSchema = Schema.Struct({
  category: ExpenseCategorySchema,
  currency: CurrencySchema,
  totalMinor: PositiveMinorUnitsSchema,
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

