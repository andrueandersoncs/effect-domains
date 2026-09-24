import { Array, Data, Effect, Equivalence, Function, Match, Option, Predicate, Schema, flow, pipe } from "effect"
import { SqlClient, Statement } from "effect/unstable/sql"

import {
  Policy,
  policyFailure,
  resolveScalarCollectionsLiteralOrSubjects,
  resolveScalarLiteralOrSubject,
  type Operand,
  type PolicyEnvironment,
  type PolicyEvaluationError,
  type PolicyF,
  type Scalar,
} from "./policy.ts"

type Binder = (sql: SqlClient.SqlClient, environment: PolicyEnvironment) => Effect.Effect<Statement.Fragment, PolicyEvaluationError>

const ScalarKindSchema = Schema.Literals(["boolean", "null", "number", "string"])
const isScalarKind = Schema.is(ScalarKindSchema)

type ScalarKind = typeof ScalarKindSchema.Type

class Expression extends Data.Class<{
  readonly fragment: Statement.Fragment
  readonly kind: "boolean" | "null" | "number" | "string" | "row"
}> {}

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

const makeScalarExpression = (sql: SqlClient.SqlClient, value: Scalar) => {
  const fragment = nativeFragment(sql`${scalarSqlValue(value)}`)
  const kind = scalarKind(value)

  return new Expression({ fragment, kind })
}

const makeRowExpression = (sql: SqlClient.SqlClient, field: string) => {
  const fragment = nativeFragment(sql`${sql(field)}`)

  return new Expression({ fragment, kind: "row" })
}

const falseExpression = (sql: SqlClient.SqlClient) => sql.literal("0=1")
const trueExpression = (sql: SqlClient.SqlClient) => sql.literal("1=1")

const numericType = (sql: SqlClient.SqlClient, expression: Statement.Fragment) =>
  pipe(sql`typeof(${expression}) IN ${sql.in(["integer", "real"])} `, nativeFragment)

const typeMatches = (sql: SqlClient.SqlClient, expression: Statement.Fragment, kind: ScalarKind) => {
  const storageType = (kind: ScalarKind) => {
    const storage = scalarKindEquals(kind, "null") ? "null" : "text"

    return nativeFragment(sql`typeof(${expression}) = ${storage}`)
  }

  return pipe(
    Match.value(kind),
    Match.whenOr("number", "boolean", () => numericType(sql, expression)),
    Match.orElse(storageType),
  )
}

const rowEquality = (sql: SqlClient.SqlClient, left: Expression, right: Expression) => {
  const leftIsNumeric = numericType(sql, left.fragment)
  const rightIsNumeric = numericType(sql, right.fragment)
  const bothNumbers = nativeFragment(sql`${leftIsNumeric} AND ${rightIsNumeric}`)
  const sameStorageKind = nativeFragment(sql`typeof(${left.fragment}) = typeof(${right.fragment})`)

  return nativeFragment(sql`(${bothNumbers} OR ${sameStorageKind}) AND ${left.fragment} IS ${right.fragment}`)
}

const rowScalarEquality = (sql: SqlClient.SqlClient, row: Statement.Fragment, scalar: Statement.Fragment, kind: ScalarKind) =>
  nativeFragment(sql`${typeMatches(sql, row, kind)} AND ${row} IS ${scalar}`)

const totalEquality = (sql: SqlClient.SqlClient, left: Expression, right: Expression) => {
  const leftKind = Option.liftPredicate(left.kind, isScalarKind)
  const rightKind = Option.liftPredicate(right.kind, isScalarKind)

  return pipe(
    Match.value(leftKind),
    Match.tagsExhaustive({
      None: () => pipe(
        Match.value(rightKind),
        Match.tagsExhaustive({
          None: () => rowEquality(sql, left, right),
          Some: ({ value }) => rowScalarEquality(sql, left.fragment, right.fragment, value),
        }),
      ),
      Some: ({ value: leftScalarKind }) => pipe(
        Match.value(rightKind),
        Match.tagsExhaustive({
          None: () => rowScalarEquality(sql, right.fragment, left.fragment, leftScalarKind),
          Some: ({ value: rightScalarKind }) =>
            scalarKindEquals(leftScalarKind, rightScalarKind)
              ? nativeFragment(sql`${left.fragment} IS ${right.fragment}`)
              : falseExpression(sql),
        }),
      ),
    }),
  )
}

const scalarExpressionFor = (sql: SqlClient.SqlClient) => (value: Scalar) => makeScalarExpression(sql, value)

const scalarOperand = Effect.fn("PolicySql.scalarOperand")(function* (
  sql: SqlClient.SqlClient,
  environment: PolicyEnvironment,
  operand: Operand,
) {
  return yield* pipe(
    Match.value(operand),
    Match.tagsExhaustive({
      Literal: (literal) => pipe(resolveScalarLiteralOrSubject(literal, environment), Effect.map(scalarExpressionFor(sql))),
      SubjectField: (subject) => pipe(resolveScalarLiteralOrSubject(subject, environment), Effect.map(scalarExpressionFor(sql))),
      RowField: ({ field }) => pipe(makeRowExpression(sql, field), Effect.succeed),
      NextField: () => policyFailure("next fields are unavailable to SQL predicates"),
    }),
  )
})

const collectionValues = Effect.fn("PolicySql.collectionValues")(function* (
  environment: PolicyEnvironment,
  operand: Operand,
) {
  return yield* pipe(
    Match.value(operand),
    Match.tagsExhaustive({
      Literal: (literal) => resolveScalarCollectionsLiteralOrSubjects(literal, environment),
      SubjectField: (subject) => resolveScalarCollectionsLiteralOrSubjects(subject, environment),
      RowField: () => policyFailure("policy collection must resolve to finite scalar values"),
      NextField: () => policyFailure("next fields are unavailable to SQL predicates"),
    }),
  )
})

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
