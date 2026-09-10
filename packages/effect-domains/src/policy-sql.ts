import { Array, Effect, Equivalence, Function, Match, Predicate, Schema, flow, pipe } from "effect"
import { SqlClient, Statement } from "effect/unstable/sql"

import {
  Policy,
  policyFailure,
  resolveScalarCollectionLiteralOrSubject,
  resolveScalarLiteralOrSubject,
  type Operand,
  type PolicyEnvironment,
  type PolicyEvaluationError,
  type PolicyF,
  type Scalar,
} from "./policy.ts"

type Binder = (sql: SqlClient.SqlClient, environment: PolicyEnvironment) => Effect.Effect<Statement.Fragment, PolicyEvaluationError>
type ScalarKind = Exclude<Expression["kind"], "row">

const FragmentSchema: Schema.declare<Statement.Fragment> = Schema.declare(Statement.isFragment)
const ExpressionKindSchema = Schema.Literals(["boolean", "null", "number", "string", "row"])
const ExpressionSchema = Schema.Struct({ fragment: FragmentSchema, kind: ExpressionKindSchema })

interface Expression extends Schema.Schema.Type<typeof ExpressionSchema> {}

const scalarKindEquals = Equivalence.strictEqual<Expression["kind"]>()
const nativeFragment = (statement: Statement.Fragment) => Statement.fragment(statement.segments)

const scalarKind = (value: Scalar) =>
  pipe(
    Match.value(value),
    Match.when(Predicate.isNull, Function.constant("null" as const)),
    Match.when(Predicate.isBoolean, Function.constant("boolean" as const)),
    Match.when(Predicate.isNumber, Function.constant("number" as const)),
    Match.orElse(Function.constant("string" as const)),
  )

const scalarSqlValue = (value: Scalar) =>
  pipe(
    Match.value(value),
    Match.when(Predicate.isBoolean, Number),
    Match.orElse(Function.identity),
  )

const makeScalarExpression = (sql: SqlClient.SqlClient, value: Scalar): Expression => {
  const scalar = scalarSqlValue(value)
  const statement = sql`${scalar}`
  const fragment = nativeFragment(statement)
  const kind = scalarKind(value)
  return ExpressionSchema.make({ fragment, kind })
}

const makeRowExpression = (sql: SqlClient.SqlClient, field: string): Expression => {
  const statement = sql`${sql(field)}`
  const fragment = nativeFragment(statement)
  return ExpressionSchema.make({ fragment, kind: "row" })
}

const falseExpression = (sql: SqlClient.SqlClient) => sql.literal("0=1")
const trueExpression = (sql: SqlClient.SqlClient) => sql.literal("1=1")

const numericType = (sql: SqlClient.SqlClient, expression: Statement.Fragment) =>
  pipe(sql`typeof(${expression}) IN ${sql.in(["integer", "real"])} `, nativeFragment)

const typeMatches = (sql: SqlClient.SqlClient, expression: Statement.Fragment, kind: ScalarKind) =>
  pipe(
    Match.value(kind),
    Match.when("number", () => numericType(sql, expression)),
    Match.orElse((storageKind) => {
      const isNull = scalarKindEquals(storageKind, "null")
      const storage = isNull ? "null" : "text"
      const statement = sql`typeof(${expression}) = ${storage}`
      return nativeFragment(statement)
    }),
  )

const storageKind = (kind: Expression["kind"]) =>
  pipe(
    Match.value(kind),
    Match.when("null", Function.constant("null" as const)),
    Match.when("string", Function.constant("string" as const)),
    Match.when("row", Function.constant("string" as const)),
    Match.orElse(Function.constant("number" as const)),
  )

const rowEquality = (sql: SqlClient.SqlClient, left: Expression, right: Expression) => {
  const leftNumeric = numericType(sql, left.fragment)
  const rightNumeric = numericType(sql, right.fragment)
  const bothNumbersStatement = sql`${leftNumeric} AND ${rightNumeric}`
  const bothNumbers = nativeFragment(bothNumbersStatement)
  const sameStorageKindStatement = sql`typeof(${left.fragment}) = typeof(${right.fragment})`
  const sameStorageKind = nativeFragment(sameStorageKindStatement)
  const equalityStatement = sql`(${bothNumbers} OR ${sameStorageKind}) AND ${left.fragment} IS ${right.fragment}`
  return nativeFragment(equalityStatement)
}

const rowLeftEquality = (sql: SqlClient.SqlClient, left: Expression, right: Expression) =>
  pipe(
    Match.value(right.kind),
    Match.when("row", () => rowEquality(sql, left, right)),
    Match.orElse((kind) => {
      const storage = storageKind(kind)
      const matches = typeMatches(sql, left.fragment, storage)
      const equalityStatement = sql`${matches} AND ${left.fragment} IS ${right.fragment}`
      return nativeFragment(equalityStatement)
    }),
  )

const scalarLeftEquality = (sql: SqlClient.SqlClient, left: Expression, right: Expression) =>
  pipe(
    Match.value(right.kind),
    Match.when("row", () => {
      const storage = storageKind(left.kind)
      const matches = typeMatches(sql, right.fragment, storage)
      const equalityStatement = sql`${matches} AND ${right.fragment} IS ${left.fragment}`
      return nativeFragment(equalityStatement)
    }),
    Match.orElse((kind) => {
      const sameKind = scalarKindEquals(left.kind, kind)
      if (!sameKind) return falseExpression(sql)
      const equalityStatement = sql`${left.fragment} IS ${right.fragment}`
      return nativeFragment(equalityStatement)
    }),
  )

const totalEquality = (sql: SqlClient.SqlClient, left: Expression, right: Expression) =>
  pipe(
    Match.value(left.kind),
    Match.when("row", () => rowLeftEquality(sql, left, right)),
    Match.orElse(() => scalarLeftEquality(sql, left, right)),
  )

const scalarExpressionFor = (sql: SqlClient.SqlClient) => (value: Scalar) => makeScalarExpression(sql, value)

const scalarOperand = (sql: SqlClient.SqlClient, environment: PolicyEnvironment, operand: Operand) =>
  pipe(
    Match.value(operand),
    Match.tagsExhaustive({
      Literal: (literal) => pipe(resolveScalarLiteralOrSubject(literal, environment), Effect.map(scalarExpressionFor(sql))),
      SubjectField: (subject) => pipe(resolveScalarLiteralOrSubject(subject, environment), Effect.map(scalarExpressionFor(sql))),
      RowField: ({ field }) => pipe(makeRowExpression(sql, field), Effect.succeed),
      NextField: () => policyFailure("next fields are unavailable to SQL predicates"),
    }),
  )

const collectionValues = (environment: PolicyEnvironment, operand: Operand) =>
  pipe(
    Match.value(operand),
    Match.tagsExhaustive({
      Literal: (literal) => resolveScalarCollectionLiteralOrSubject(literal, environment),
      SubjectField: (subject) => resolveScalarCollectionLiteralOrSubject(subject, environment),
      RowField: () => policyFailure("policy collection must resolve to finite scalar values"),
      NextField: () => policyFailure("next fields are unavailable to SQL predicates"),
    }),
  )

const bindConstant = ({ value }: Extract<PolicyF<Binder>, { readonly _tag: "Constant" }>): Binder =>
  flow(value ? trueExpression : falseExpression, Effect.succeed)

const bindEqual = ({ left, right }: Extract<PolicyF<Binder>, { readonly _tag: "Equal" }>): Binder =>
  Effect.fn("PolicySql.equal")(function* (sql, environment) {
    const leftExpression = yield* scalarOperand(sql, environment, left)
    const rightExpression = yield* scalarOperand(sql, environment, right)
    return totalEquality(sql, leftExpression, rightExpression)
  })

const entryEquality = (sql: SqlClient.SqlClient, member: Expression) => (entry: Scalar) => {
  const expression = makeScalarExpression(sql, entry)
  return totalEquality(sql, member, expression)
}

const bindIncludes = ({ collection, value }: Extract<PolicyF<Binder>, { readonly _tag: "Includes" }>): Binder =>
  Effect.fn("PolicySql.includes")(function* (sql, environment) {
    const entries = yield* collectionValues(environment, collection)
    if (Array.isReadonlyArrayEmpty(entries)) return falseExpression(sql)
    const member = yield* scalarOperand(sql, environment, value)
    const equalities = Array.map(entries, entryEquality(sql, member))
    const statement = sql.or(equalities)
    return nativeFragment(statement)
  })

const joinFragments = (sql: SqlClient.SqlClient, all: boolean, fragments: ReadonlyArray<Statement.Fragment>) => {
  if (Array.isReadonlyArrayEmpty(fragments)) return all ? trueExpression(sql) : falseExpression(sql)
  const statement = all ? sql.and(fragments) : sql.or(fragments)
  return nativeFragment(statement)
}

const bindJunction = (children: ReadonlyArray<Binder>, all: boolean): Binder =>
  Effect.fn("PolicySql.junction")(function* (sql, environment) {
    const effects = Array.map(children, (child) => child(sql, environment))
    const fragments = yield* Effect.all(effects)
    return joinFragments(sql, all, fragments)
  })

const compileLayer = (layer: PolicyF<Binder>) =>
  pipe(
    Match.value(layer),
    Match.tagsExhaustive({
      Constant: bindConstant,
      Equal: bindEqual,
      Includes: bindIncludes,
      All: ({ children }) => bindJunction(children, true),
      Any: ({ children }) => bindJunction(children, false),
    }),
  )

export const PolicySql = { compile: Policy.fold<Binder>(compileLayer) }
