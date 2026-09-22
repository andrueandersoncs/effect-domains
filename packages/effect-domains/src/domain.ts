import { Array, type Brand, Equivalence, Schema } from "effect"

export const UuidV7Schema = Schema.String.check(Schema.isUUID(7))

export const CalendarDateSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter((date: string) => {
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
  }),
)

export const SafeIntSchema = Schema.Int.check(
  Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
)

export const NonNegativeSafeIntSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)

export const PositiveSafeIntSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
)

export const PageLimitSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))


export type StructSchema = Schema.Struct<Schema.Struct.Fields>
export type StructValue = StructSchema["Type"]


export const DomainIdentifier = "@effect-domains/domain/identifier"

export const identifier = <S extends Schema.Top>(
  schema: S,
) =>
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  schema.annotate({
    [DomainIdentifier]: true,
  }) as S & Brand.Brand<typeof DomainIdentifier>
