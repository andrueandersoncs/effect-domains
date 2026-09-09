import { Array, Effect, Equivalence, Function, Match, Option, Predicate, Record, Schema, pipe } from "effect"
import { SqlClient, type Statement } from "effect/unstable/sql"
import {
  Policy,
  PolicyEvaluationError,
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

type ScalarExpressionMatch = (
  fragment: Statement.Fragment,
  kind: ExpressionKind,
) => Statement.Fragment

type ScalarExpression = (match: ScalarExpressionMatch) => Statement.Fragment

const scalarKind = (value: Scalar): ScalarKind =>
  pipe(
    Match.value(value),
    Match.when(Predicate.isNull, Function.constant("null" as const)),
    Match.when(Predicate.isBoolean, Function.constant("boolean" as const)),
    Match.when(Predicate.isNumber, Function.constant("number" as const)),
    Match.orElse(Function.constant("string" as const)),
  )

const matchExpression = (kind: ExpressionKind) => (fragment: Statement.Fragment) =>
  (match: ScalarExpressionMatch) => match(fragment, kind)

const scalarExpression = (sql: SqlClient.SqlClient) => (value: Scalar) => {
  const kind = scalarKind(value)
  const boolean = Equivalence.strictEqual<ScalarKind>()(kind, "boolean")
  const encoded = boolean ? Number(value) : value
  return pipe(sql`${encoded}`, matchExpression(kind))
}

const rowExpression = (sql: SqlClient.SqlClient) => (field: string) =>
  pipe(sql`${sql(field)}`, matchExpression("row"))

const nullTypeMatch = (sql: SqlClient.SqlClient, expression: Statement.Fragment) => (): Statement.Fragment =>
  sql`typeof(${expression}) = ${"null"}`

const numericTypeMatch = (sql: SqlClient.SqlClient, expression: Statement.Fragment) => (): Statement.Fragment =>
  sql`typeof(${expression}) IN ${sql.in(["integer", "real"])}`

const textTypeMatch = (sql: SqlClient.SqlClient, expression: Statement.Fragment) => (): Statement.Fragment =>
  sql`typeof(${expression}) = ${"text"}`

const typeMatches = (
  sql: SqlClient.SqlClient,
  expression: Statement.Fragment,
  kind: Exclude<ScalarKind, "boolean">,
) =>
  pipe(
    Match.value(kind),
    Match.when("null", nullTypeMatch(sql, expression)),
    Match.when("number", numericTypeMatch(sql, expression)),
    Match.when("string", textTypeMatch(sql, expression)),
    Match.exhaustive,
  )

const StorageKinds = {
  boolean: "number",
  null: "null",
  number: "number",
  string: "string",
} as const

const storageKind = (kind: ScalarKind) => StorageKinds[kind]

const numericType = (
  sql: SqlClient.SqlClient,
  expression: Statement.Fragment,
): Statement.Fragment =>
  sql`typeof(${expression}) IN ${sql.in(["integer", "real"])}`

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

const matchingRows = (
  sql: SqlClient.SqlClient,
  left: Statement.Fragment,
  right: Statement.Fragment,
) => (): Statement.Fragment => rowEquality(sql, left, right)

const rejectedComparison = (sql: SqlClient.SqlClient) => (): Statement.Fragment =>
  falseExpression(sql)

const matchingRowScalar = (
  sql: SqlClient.SqlClient,
  left: Statement.Fragment,
  right: Statement.Fragment,
  kind: ScalarKind,
) => (): Statement.Fragment => {
  const physical = storageKind(kind)
  const matches = typeMatches(sql, left, physical)
  return sql`${matches} AND ${left} IS ${right}`
}

const rowComparison = (
  sql: SqlClient.SqlClient,
  left: Statement.Fragment,
  right: Statement.Fragment,
  rightKind: ExpressionKind,
) =>
  pipe(
    Match.value(rightKind),
    Match.when("row", matchingRows(sql, left, right)),
    Match.when("boolean", matchingRowScalar(sql, left, right, "boolean")),
    Match.when("null", matchingRowScalar(sql, left, right, "null")),
    Match.when("number", matchingRowScalar(sql, left, right, "number")),
    Match.when("string", matchingRowScalar(sql, left, right, "string")),
    Match.exhaustive,
  )

const matchingScalars = (
  sql: SqlClient.SqlClient,
  left: Statement.Fragment,
  right: Statement.Fragment,
) => (): Statement.Fragment => sql`${left} IS ${right}`

const matchingScalarRow = (
  sql: SqlClient.SqlClient,
  left: Statement.Fragment,
  leftKind: ScalarKind,
  right: Statement.Fragment,
) => (): Statement.Fragment =>
  pipe(
    Match.value(leftKind),
    Match.when("boolean", matchingRowScalar(sql, right, left, "boolean")),
    Match.when("null", matchingRowScalar(sql, right, left, "null")),
    Match.when("number", matchingRowScalar(sql, right, left, "number")),
    Match.when("string", matchingRowScalar(sql, right, left, "string")),
    Match.exhaustive,
  )

const scalarComparison = (
  sql: SqlClient.SqlClient,
  left: Statement.Fragment,
  leftKind: ScalarKind,
  right: Statement.Fragment,
  rightKind: ExpressionKind,
) =>
  pipe(
    Match.value(rightKind),
    Match.when("row", matchingScalarRow(sql, left, leftKind, right)),
    Match.when(leftKind, matchingScalars(sql, left, right)),
    Match.orElse(rejectedComparison(sql)),
  )

const compareRowExpression = (
  sql: SqlClient.SqlClient,
  leftFragment: Statement.Fragment,
  rightFragment: Statement.Fragment,
  rightKind: ExpressionKind,
) => (): Statement.Fragment =>
  rowComparison(sql, leftFragment, rightFragment, rightKind)

const compareScalarExpression = (
  sql: SqlClient.SqlClient,
  leftFragment: Statement.Fragment,
  rightFragment: Statement.Fragment,
  rightKind: ExpressionKind,
) => (kind: ScalarKind): Statement.Fragment =>
  scalarComparison(sql, leftFragment, kind, rightFragment, rightKind)

const comparisonForRight = (
  sql: SqlClient.SqlClient,
  leftFragment: Statement.Fragment,
  leftKind: ExpressionKind,
) => (rightFragment: Statement.Fragment, rightKind: ExpressionKind): Statement.Fragment =>
  pipe(
    Match.value(leftKind),
    Match.when("row", compareRowExpression(sql, leftFragment, rightFragment, rightKind)),
    Match.orElse(compareScalarExpression(sql, leftFragment, rightFragment, rightKind)),
  )

const comparisonForLeft = (
  sql: SqlClient.SqlClient,
  right: ScalarExpression,
) => (leftFragment: Statement.Fragment, leftKind: ExpressionKind): Statement.Fragment =>
  right(comparisonForRight(sql, leftFragment, leftKind))

const totalEquality = (
  sql: SqlClient.SqlClient,
  left: ScalarExpression,
  right: ScalarExpression,
) => left(comparisonForLeft(sql, right))

const sqlEvaluationFailure = (reason: string) =>
  pipe(PolicyEvaluationError.make({ reason }), Effect.fail)

const ScalarSchema = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null])
const ScalarCollectionSchema = Schema.Array(ScalarSchema)
const isSqlScalar = Schema.is(ScalarSchema)
const isSqlScalarValues = Schema.is(ScalarCollectionSchema)

const subjectValue = (
  environment: PolicyEnvironment,
  field: string,
): Effect.Effect<unknown, PolicyEvaluationError> => {
  const value = Record.get(environment.subject, field)
  const unavailable = () => sqlEvaluationFailure(`subject.${field} is unavailable`)

  return Option.match(value, { onNone: unavailable, onSome: Effect.succeed })
}

const subjectValueFor = (environment: PolicyEnvironment) => (field: string) =>
  subjectValue(environment, field)

const unresolvedSqlScalar = () =>
  sqlEvaluationFailure("policy operand must resolve to a finite scalar")

const resolvedSqlScalar = (sql: SqlClient.SqlClient) =>
  Function.flow(scalarExpression(sql), Effect.succeed)

const resolveSqlScalar = (sql: SqlClient.SqlClient) => (value: unknown) =>
  pipe(
    Match.value(value),
    Match.when(isSqlScalar, resolvedSqlScalar(sql)),
    Match.orElse(unresolvedSqlScalar),
  )

const literalValue = ({ value }: Extract<Operand, { readonly _tag: "Literal" }>) => value
const subjectFieldName = ({ field }: Extract<Operand, { readonly _tag: "SubjectField" }>) => field
const rowFieldName = ({ field }: Extract<Operand, { readonly _tag: "RowField" }>) => field

const scalarLiteral = (sql: SqlClient.SqlClient) =>
  Function.flow(literalValue, resolveSqlScalar(sql))

const scalarSubject = (
  sql: SqlClient.SqlClient,
  environment: PolicyEnvironment,
) =>
  Function.flow(
    subjectFieldName,
    subjectValueFor(environment),
    Effect.flatMap(resolveSqlScalar(sql)),
  )

const scalarRow = (sql: SqlClient.SqlClient) =>
  Function.flow(rowFieldName, rowExpression(sql), Effect.succeed)

const unavailableNextScalar = () => sqlEvaluationFailure("next fields are unavailable to SQL predicates")

const scalarOperand = (
  sql: SqlClient.SqlClient,
  environment: PolicyEnvironment,
  operand: Operand,
) =>
  pipe(
    Match.value(operand),
    Match.tagsExhaustive({
      Literal: scalarLiteral(sql),
      SubjectField: scalarSubject(sql, environment),
      RowField: scalarRow(sql),
      NextField: unavailableNextScalar,
    }),
  )

const unresolvedSqlCollection = () =>
  sqlEvaluationFailure("policy collection must resolve to finite scalar values")

const resolveSqlScalars = (
  value: unknown,
): Effect.Effect<ReadonlyArray<Scalar>, PolicyEvaluationError> =>
  isSqlScalarValues(value)
    ? Effect.succeed(value)
    : unresolvedSqlCollection()

const collectionLiteral = Function.flow(literalValue, resolveSqlScalars)

const collectionSubject = (environment: PolicyEnvironment) =>
  Function.flow(
    subjectFieldName,
    subjectValueFor(environment),
    Effect.flatMap(resolveSqlScalars),
  )

const unavailableCollection = () => sqlEvaluationFailure("policy collection must resolve to finite scalar values")

const collectionValues = (environment: PolicyEnvironment, operand: Operand) =>
  pipe(
    Match.value(operand),
    Match.tagsExhaustive({
      Literal: collectionLiteral,
      SubjectField: collectionSubject(environment),
      RowField: unavailableCollection,
      NextField: unavailableNextScalar,
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

const compareExpression = (sql: SqlClient.SqlClient, value: ScalarExpression) =>
  (entryValue: ScalarExpression): Statement.Fragment =>
    totalEquality(sql, value, entryValue)

const comparisonFor = (
  sql: SqlClient.SqlClient,
  value: ScalarExpression,
) =>
  Function.flow(scalarExpression(sql), compareExpression(sql, value))

const bindMembership = ({
  collection,
  value,
}: Extract<PolicyF<Binder>, { readonly _tag: "Includes" }>): Binder =>
  Effect.fn("PolicySql.includes")(function* (sql, environment) {
    const entries = yield* collectionValues(environment, collection)
    const valueExpression = yield* scalarOperand(sql, environment, value)

    if (!Array.isReadonlyArrayNonEmpty(entries)) return falseExpression(sql)

    const comparisons = Array.map(entries, comparisonFor(sql, valueExpression))
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
