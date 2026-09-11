import { Record, Schema, SchemaGetter, SchemaIssue, pipe } from "effect"

const IntegerText = Schema.Trim.check(Schema.isPattern(/^[+-]?\d+$/))
const NumberText = Schema.Trim.check(Schema.isPattern(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/))
const FiniteNumber = Schema.Number.check(Schema.isFinite())
const IntegerValue = pipe(IntegerText, Schema.decodeTo(Schema.NumberFromString), Schema.decodeTo(Schema.Int))
const NumberValue = pipe(NumberText, Schema.decodeTo(Schema.NumberFromString), Schema.decodeTo(FiniteNumber))

const integer = <S extends Schema.Codec<number, number, unknown, unknown>>(target: S) =>
  pipe(IntegerValue, Schema.decodeTo(target))

const number = <S extends Schema.Codec<number, number, unknown, unknown>>(target: S) =>
  pipe(NumberValue, Schema.decodeTo(target))

const nullableText = <S extends Schema.Codec<string, string, unknown, unknown>>(target: S) => pipe(
  Schema.Trim,
  Schema.decodeTo(Schema.NullOr(target), {
    decode: SchemaGetter.transform((value: string) => value === "" ? null : value),
    encode: SchemaGetter.transform((value: string | null) => value ?? ""),
  }),
)

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()
const errors = (error: Schema.SchemaError): Readonly<Record<string, string>> => Record.fromEntries(
  formatIssues(error.issue).issues.map((issue) => {
    const path = issue.path?.map((part) => typeof part === "object" ? String(part.key) : String(part)).join(".")
    return [path || "$", issue.message] as const
  }),
)

export const Form = { integer, number, nullableText, errors }
