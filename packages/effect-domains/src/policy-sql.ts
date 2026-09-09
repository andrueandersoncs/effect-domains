import { Array, Effect, Equivalence, Function, Match, Predicate, Schema, pipe } from "effect"
import { SqlClient, type Statement } from "effect/unstable/sql"

import {
  Policy,
  PolicyEvaluationError,
  resolveScalarCollectionLiteralOrSubject,
  resolveScalarLiteralOrSubject,
  type Operand,
  type PolicyEnvironment,
  type PolicyF,
  type Scalar,
} from "./policy.ts"

type Binder = (
  sql: SqlClient.SqlClient,
  environment: PolicyEnvironment,
) => Effect.Effect<Statement.Fragment, PolicyEvaluationError>

type ScalarKind = "boolean" | "null" | "number" | "string"
type ExpressionKind = ScalarKind | "row"

const ScalarExpressionKindSchema = Schema.Literals(["boolean", "null", "number", "row", "string"])

class ScalarExpression extends Schema.Class<ScalarExpression>("ScalarExpression")({
  fragment: Schema.Unknown,
  kind: ScalarExpressionKindSchema,
}) {
  declare readonly fragment: Statement.Fragment
}

const expressionKindEquals = Equivalence.strictEqual<ExpressionKind>()

const scalarKind = (value: Scalar): ScalarKind =>
  pipe(
    Match.value(value),
    Match.when(Predicate.isNull, Function.constant("null" as const)),
    Match.when(Predicate.isBoolean, Function.constant("boolean" as const)),
    Match.when(Predicate.isNumber, Function.constant("number" as const)),
    Match.orElse(Function.constant("string" as const)),
  )

const scalarExpression = (sql: SqlClient.SqlClient) => (value: Scalar): ScalarExpression => {
  const kind = scalarKind(value)
  const boolean = pipe(kind, Match.value, Match.when("boolean", Function.constant(true)), Match.orElse(Function.constant(false)))
  const storedValue = boolean ? Number(value) : value
  const fragment = sql`${storedValue}`
  return ScalarExpression.make({ fragment, kind })
}

const rowExpression = (sql: SqlClient.SqlClient) => (field: string): ScalarExpression => {
  const fragment = sql`${sql(field)}`
  return ScalarExpression.make({ fragment, kind: "row" })
}

const numericType = (sql: SqlClient.SqlClient, expression: Statement.Fragment): Statement.Fragment =>
  sql`typeof(${expression}) IN ${sql.in(["integer", "real"])}`

const typeMatches = (
  sql: SqlClient.SqlClient,
  expression: Statement.Fragment,
  kind: "null" | "number" | "string",
) =>
  pipe(
    Match.value(kind),
    Match.when("null", () => sql`typeof(${expression}) = ${"null"}`),
    Match.when("number", () => numericType(sql, expression)),
    Match.orElse(() => sql`typeof(${expression}) = ${"text"}`),
  )

const storageKind = (kind: ScalarKind) =>
  pipe(
    Match.value(kind),
    Match.when("boolean", Function.constant("number" as const)),
    Match.when("null", Function.constant("null" as const)),
    Match.when("number", Function.constant("number" as const)),
    Match.when("string", Function.constant("string" as const)),
    Match.exhaustive,
  )

const rowEquality = (
  sql: SqlClient.SqlClient,
  left: Statement.Fragment,
  right: Statement.Fragment,
): Statement.Fragment => sql`(
  (${numericType(sql, left)} AND ${numericType(sql, right)})
  OR typeof(${left}) = typeof(${right})
) AND ${left} IS ${right}`

const falseExpression = (sql: SqlClient.SqlClient) => sql.literal("0=1")
const trueExpression = (sql: SqlClient.SqlClient) => sql.literal("1=1")

const rowScalarEquality = (
  sql: SqlClient.SqlClient,
  row: Statement.Fragment,
  scalar: Statement.Fragment,
  kind: ScalarKind,
): Statement.Fragment => {
  const expectedKind = storageKind(kind)
  const matchingType = typeMatches(sql, row, expectedKind)
  return sql`${matchingType} AND ${row} IS ${scalar}`
}

const totalEquality = (
  sql: SqlClient.SqlClient,
  left: ScalarExpression,
  right: ScalarExpression,
) =>
  pipe(
    Match.value([left.kind, right.kind] as const),
    Match.when(["row", "row"], () => rowEquality(sql, left.fragment, right.fragment)),
    Match.when(["row", Match.any], () => rowScalarEquality(sql, left.fragment, right.fragment, right.kind as ScalarKind)),
    Match.when([Match.any, "row"], () => rowScalarEquality(sql, right.fragment, left.fragment, left.kind as ScalarKind)),
    Match.when([Match.any, Match.any], ([leftKind, rightKind]) => {
      const matchingKind = expressionKindEquals(leftKind, rightKind)
      return matchingKind ? sql`${left.fragment} IS ${right.fragment}` : falseExpression(sql)
    }),
    Match.exhaustive,
  )

const sqlEvaluationFailure = (reason: string) =>
  pipe(PolicyEvaluationError.make({ reason }), Effect.fail)

const nextFieldUnavailable = sqlEvaluationFailure("next fields are unavailable to SQL predicates")
const collectionRequired = sqlEvaluationFailure("policy collection must resolve to finite scalar values")

const scalarOperand = (
  sql: SqlClient.SqlClient,
  environment: PolicyEnvironment,
  operand: Operand,
) =>
  pipe(
    Match.value(operand),
    Match.tagsExhaustive({
      Literal: (value) => pipe(resolveScalarLiteralOrSubject(value, environment), Effect.map(scalarExpression(sql))),
      SubjectField: (value) => pipe(resolveScalarLiteralOrSubject(value, environment), Effect.map(scalarExpression(sql))),
      RowField: ({ field }) => {
        const expression = rowExpression(sql)
        const row = expression(field)
        return Effect.succeed(row)
      },
      NextField: Function.constant(nextFieldUnavailable),
    }),
  )

const collectionValues = (
  environment: PolicyEnvironment,
  operand: Operand,
) =>
  pipe(
    Match.value(operand),
    Match.tagsExhaustive({
      Literal: (value) => resolveScalarCollectionLiteralOrSubject(value, environment),
      SubjectField: (value) => resolveScalarCollectionLiteralOrSubject(value, environment),
      RowField: Function.constant(collectionRequired),
      NextField: Function.constant(nextFieldUnavailable),
    }),
  )

const constantCondition = (sql: SqlClient.SqlClient) => (value: boolean) =>
  value ? trueExpression(sql) : falseExpression(sql)

const constantBinding = ({ value }: Extract<PolicyF<Binder>, { readonly _tag: "Constant" }>): Binder =>
  (sql, _environment) =>
    pipe(value, constantCondition(sql), Effect.succeed)

const bindEquality = ({
  left,
  right,
}: Extract<PolicyF<Binder>, { readonly _tag: "Equal" }>): Binder =>
  Effect.fn("PolicySql.equal")(function* (sql, environment) {
    const leftValue = yield* scalarOperand(sql, environment, left)
    const rightValue = yield* scalarOperand(sql, environment, right)
    return totalEquality(sql, leftValue, rightValue)
  })

const bindMembership = ({
  collection,
  value,
}: Extract<PolicyF<Binder>, { readonly _tag: "Includes" }>): Binder =>
  Effect.fn("PolicySql.includes")(function* (sql, environment) {
    const entries = yield* collectionValues(environment, collection)
    const valueExpression = yield* scalarOperand(sql, environment, value)
    const expression = scalarExpression(sql)

    if (!Array.isReadonlyArrayNonEmpty(entries)) return falseExpression(sql)

    const comparison = (entry: Scalar) => {
      const entryExpression = expression(entry)
      return totalEquality(sql, valueExpression, entryExpression)
    }

    const comparisons = Array.map(entries, comparison)
    return sql.or(comparisons)
  })

const bindChild = (sql: SqlClient.SqlClient, environment: PolicyEnvironment) => (child: Binder) =>
  child(sql, environment)

const allFragments = (sql: SqlClient.SqlClient) => (fragments: ReadonlyArray<Statement.Fragment>) =>
  Array.isReadonlyArrayNonEmpty(fragments) ? sql.and(fragments) : trueExpression(sql)

const anyFragments = (sql: SqlClient.SqlClient) => (fragments: ReadonlyArray<Statement.Fragment>) =>
  Array.isReadonlyArrayNonEmpty(fragments) ? sql.or(fragments) : falseExpression(sql)

const allBinding = ({ children }: Extract<PolicyF<Binder>, { readonly _tag: "All" }>): Binder =>
  (sql, environment) =>
    pipe(
      children,
      Array.map(bindChild(sql, environment)),
      Effect.all,
      Effect.map(allFragments(sql)),
    )

const anyBinding = ({ children }: Extract<PolicyF<Binder>, { readonly _tag: "Any" }>): Binder =>
  (sql, environment) =>
    pipe(
      children,
      Array.map(bindChild(sql, environment)),
      Effect.all,
      Effect.map(anyFragments(sql)),
    )

const compileLayer = (layer: PolicyF<Binder>) =>
  pipe(
    Match.value(layer),
    Match.tagsExhaustive({
      Constant: constantBinding,
      Equal: bindEquality,
      Includes: bindMembership,
      All: allBinding,
      Any: anyBinding,
    }),
  )

const compile = Policy.fold<Binder>(compileLayer)
export const PolicySql = { compile }
