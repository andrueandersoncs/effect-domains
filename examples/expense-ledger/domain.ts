import { Array, Equivalence, Schema } from "effect"

const validDate = Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)

const validGregorianDate = Schema.makeFilter((date: string) => {
  const [yearText, monthText, dayText] = date.split("-")
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const divisibleByFour = Equivalence.strictEqual<number>()(year % 4, 0)
  const divisibleByCentury = Equivalence.strictEqual<number>()(year % 100, 0)
  const divisibleByFourCenturies = Equivalence.strictEqual<number>()(year % 400, 0)
  const ordinaryCentury = !divisibleByCentury
  const leapCentury = ordinaryCentury || divisibleByFourCenturies
  const leapYear = divisibleByFour && leapCentury
  const februaryDays = leapYear ? 29 : 28
  const february = Equivalence.strictEqual<number>()(month, 2)
  const shortMonth = Array.contains([4, 6, 9, 11], month)
  const otherMonthDays = shortMonth ? 30 : 31
  const daysInMonth = february ? februaryDays : otherMonthDays
  const validMonth = month >= 1 && month <= 12
  const validDay = day >= 1 && day <= daysInMonth
  const validCalendar = validMonth && validDay

  return validCalendar ? undefined : "a valid Gregorian calendar date"
})

const validCurrency = Schema.isPattern(/^[A-Z]{3}$/)
const atLeastOne = Schema.isGreaterThanOrEqualTo(1)
const atMostSafeInteger = Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
const atMostOneHundred = Schema.isLessThanOrEqualTo(100)
export const ExpenseDateSchema = Schema.String.check(validDate, validGregorianDate)
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
  date: ExpenseDateSchema,
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
  from: ExpenseDateSchema,
  through: ExpenseDateSchema,
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
  { from: ExpenseDateSchema, through: ExpenseDateSchema },
) {}

export class ExpenseLedgerUnavailable extends Schema.TaggedError<ExpenseLedgerUnavailable>()(
  "ExpenseLedgerUnavailable",
  {},
) {}

interface ExpenseTotal extends Schema.Schema.Type<typeof ExpenseTotalSchema> {}
