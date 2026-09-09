import { Array, Effect, Match, pipe } from "effect"
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
type ScalarExpression = Readonly<{
  readonly fragment: Statement.Fragment
  readonly kind: ExpressionKind
}>

const scalarKind = (value: Scalar): ScalarKind => {
  if (value === null) return "null"
  if (typeof value === "boolean") return "boolean"
  if (typeof value === "number") return "number"
  return "string"
}

const scalarExpression = (sql: SqlClient.SqlClient) => (value: Scalar): ScalarExpression => {
  const kind = scalarKind(value)
  return { fragment: sql`${kind === "boolean" ? Number(value) : value}`, kind }
}

const rowExpression = (sql: SqlClient.SqlClient) => (field: string): ScalarExpression => ({
  fragment: sql`${sql(field)}`,
  kind: "row",
})

const numericType = (sql: SqlClient.SqlClient, expression: Statement.Fragment): Statement.Fragment =>
  sql`typeof(${expression}) IN ${sql.in(["integer", "real"])}`

const typeMatches = (
  sql: SqlClient.SqlClient,
  expression: Statement.Fragment,
  kind: "null" | "number" | "string",
): Statement.Fragment =>
  kind === "null"
    ? sql`typeof(${expression}) = ${"null"}`
    : kind === "number"
      ? numericType(sql, expression)
      : sql`typeof(${expression}) = ${"text"}`

const storageKind = (kind: ScalarKind): "null" | "number" | "string" =>
  kind === "boolean" ? "number" : kind

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
): Statement.Fragment => sql`${typeMatches(sql, row, storageKind(kind))} AND ${row} IS ${scalar}`

const totalEquality = (
  sql: SqlClient.SqlClient,
  left: ScalarExpression,
  right: ScalarExpression,
): Statement.Fragment => {
  if (left.kind === "row") {
    return right.kind === "row"
      ? rowEquality(sql, left.fragment, right.fragment)
      : rowScalarEquality(sql, left.fragment, right.fragment, right.kind)
  }
  if (right.kind === "row") return rowScalarEquality(sql, right.fragment, left.fragment, left.kind)
  return left.kind === right.kind ? sql`${left.fragment} IS ${right.fragment}` : falseExpression(sql)
}

const sqlEvaluationFailure = (reason: string) =>
  pipe(PolicyEvaluationError.make({ reason }), Effect.fail)

const scalarOperand = (
  sql: SqlClient.SqlClient,
  environment: PolicyEnvironment,
  operand: Operand,
): Effect.Effect<ScalarExpression, PolicyEvaluationError> => {
  switch (operand._tag) {
    case "Literal":
    case "SubjectField":
      return pipe(resolveScalarLiteralOrSubject(operand, environment), Effect.map(scalarExpression(sql)))
    case "RowField":
      return Effect.succeed(rowExpression(sql)(operand.field))
    case "NextField":
      return sqlEvaluationFailure("next fields are unavailable to SQL predicates")
  }
}

const collectionValues = (
  environment: PolicyEnvironment,
  operand: Operand,
): Effect.Effect<ReadonlyArray<Scalar>, PolicyEvaluationError> => {
  switch (operand._tag) {
    case "Literal":
    case "SubjectField":
      return resolveScalarCollectionLiteralOrSubject(operand, environment)
    case "RowField":
      return sqlEvaluationFailure("policy collection must resolve to finite scalar values")
    case "NextField":
      return sqlEvaluationFailure("next fields are unavailable to SQL predicates")
  }
}

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

    if (!Array.isReadonlyArrayNonEmpty(entries)) return falseExpression(sql)

    const expression = scalarExpression(sql)
    const comparisons = Array.map(entries, (entry) => totalEquality(sql, valueExpression, expression(entry)))
    return sql.or(comparisons)
  })

const bindChild = (sql: SqlClient.SqlClient, environment: PolicyEnvironment) => (child: Binder) =>
  child(sql, environment)

const allFragments = (sql: SqlClient.SqlClient) => (fragments: ReadonlyArray<Statement.Fragment>) =>
  Array.isReadonlyArrayNonEmpty(fragments) ? sql.and(fragments) : trueExpression(sql)

const anyFragments = (sql: SqlClient.SqlClient) => (fragments: ReadonlyArray<Statement.Fragment>) =>
  Array.isReadonlyArrayNonEmpty(fragments) ? sql.or(fragments) : falseExpression(sql)

const bindAll = (sql: SqlClient.SqlClient, environment: PolicyEnvironment) =>
  (children: ReadonlyArray<Binder>) =>
    pipe(
      children,
      Array.map(bindChild(sql, environment)),
      Effect.all,
      Effect.map(allFragments(sql)),
    )

const bindAny = (sql: SqlClient.SqlClient, environment: PolicyEnvironment) =>
  (children: ReadonlyArray<Binder>) =>
    pipe(
      children,
      Array.map(bindChild(sql, environment)),
      Effect.all,
      Effect.map(anyFragments(sql)),
    )

const allBinding = ({ children }: Extract<PolicyF<Binder>, { readonly _tag: "All" }>): Binder =>
  (sql, environment) => bindAll(sql, environment)(children)

const anyBinding = ({ children }: Extract<PolicyF<Binder>, { readonly _tag: "Any" }>): Binder =>
  (sql, environment) => bindAny(sql, environment)(children)

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
