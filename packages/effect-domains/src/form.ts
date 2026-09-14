import { Array, Equivalence, Function, Option, Predicate, Record, Schema, SchemaGetter, SchemaIssue, flow, pipe } from "effect"

const IntegerTextSchema = Schema.Trim.check(Schema.isPattern(/^[+-]?\d+$/))
const NullableIntegerTextSchema = Schema.Trim.check(Schema.isPattern(/^(?:[+-]?\d+)?$/))
const NumberTextSchema = Schema.Trim.check(Schema.isPattern(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/))
const FiniteNumberSchema = Schema.Number.check(Schema.isFinite())
const IntegerValueSchema = pipe(IntegerTextSchema, Schema.decodeTo(Schema.NumberFromString), Schema.decodeTo(Schema.Int))
const NumberValueSchema = pipe(NumberTextSchema, Schema.decodeTo(Schema.NumberFromString), Schema.decodeTo(FiniteNumberSchema))
const sameString = Equivalence.strictEqual<string>()
const stringToNullable = (value: string) => sameString(value, "") ? null : value
const nullableStringToString = (value: string | null) => value ?? ""
const stringToNullableInteger = (value: string) => sameString(value, "") ? null : Number(value)
const nullableNumberToString = (value: number | null) => Predicate.isNull(value) ? "" : String(value)

const text = <S extends Schema.Codec<string, string, unknown, unknown>>(target: S) =>
  pipe(Schema.Trim, Schema.decodeTo(target))

const integer = <S extends Schema.Codec<number, number, unknown, unknown>>(target: S) =>
  pipe(IntegerValueSchema, Schema.decodeTo(target))

const number = <S extends Schema.Codec<number, number, unknown, unknown>>(target: S) =>
  pipe(NumberValueSchema, Schema.decodeTo(target))

const nullableInteger = <S extends Schema.Codec<number, number, unknown, unknown>>(target: S) => pipe(
  NullableIntegerTextSchema,
  Schema.decodeTo(Schema.NullOr(target), {
    decode: SchemaGetter.transform(stringToNullableInteger),
    encode: SchemaGetter.transform(nullableNumberToString),
  }),
)

const nullableText = <S extends Schema.Codec<unknown, string, unknown, unknown>>(target: S) => pipe(
  Schema.Trim,
  Schema.decodeTo(Schema.NullOr(target), {
    decode: SchemaGetter.transform(stringToNullable),
    encode: SchemaGetter.transform(nullableStringToString),
  }),
)

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

const errors = (error: Schema.SchemaError): Readonly<Record<string, string>> => {
  const formatted = formatIssues(error.issue)

  const issueEntry = (issue: (typeof formatted.issues)[number]) => {
    const pathPart = (part: NonNullable<typeof issue.path>[number]) =>
      Predicate.isObject(part) ? String(part.key) : String(part)

    const path = pipe(
      Option.fromNullishOr(issue.path),
      Option.map(flow(Array.map(pathPart), Array.join("."))),
      Option.filter(Predicate.isTruthy),
      Option.getOrElse(Function.constant("$")),
    )

    return [path, issue.message] as const
  }

  const entries = Array.map(formatted.issues, issueEntry)

  return Record.fromEntries(entries)
}

export const Form = { text, integer, nullableInteger, number, nullableText, errors }
