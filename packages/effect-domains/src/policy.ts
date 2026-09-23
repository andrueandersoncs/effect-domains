import { Array, Data, Effect, Equivalence, Function, Match, Option, Predicate, Record, Schema, Struct, pipe } from "effect"
import type { StructValue } from "./domain.ts"

export type Scalar = string | number | boolean | null

const ScalarSchema = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null])
const ScalarCollectionSchema = Schema.Array(ScalarSchema)
const LiteralSchema = Schema.TaggedStruct("Literal", { value: Schema.Union([ScalarSchema, ScalarCollectionSchema]) })
const SubjectFieldSchema = Schema.TaggedStruct("SubjectField", { field: Schema.String })
const RowFieldSchema = Schema.TaggedStruct("RowField", { field: Schema.String })
const NextFieldSchema = Schema.TaggedStruct("NextField", { field: Schema.String })

export const OperandSchema = Schema.Union([LiteralSchema, SubjectFieldSchema, RowFieldSchema, NextFieldSchema])

export type Operand = Schema.Schema.Type<typeof OperandSchema>

type Literal = Schema.Schema.Type<typeof LiteralSchema>

const ConstantSchema = Schema.TaggedStruct("Constant", { value: Schema.Boolean })
const EqualSchema = Schema.TaggedStruct("Equal", { left: OperandSchema, right: OperandSchema })
const IncludesSchema = Schema.TaggedStruct("Includes", { collection: OperandSchema, value: OperandSchema })

type PolicyTerminal = Schema.Schema.Type<typeof ConstantSchema> | Schema.Schema.Type<typeof EqualSchema> | Schema.Schema.Type<typeof IncludesSchema>

const allLayer = <A extends Schema.Constraint>(child: A) => Schema.TaggedStruct("All", { children: Schema.Array(child) })
const anyLayer = <A extends Schema.Constraint>(child: A) => Schema.TaggedStruct("Any", { children: Schema.Array(child) })

export type Policy = PolicyTerminal | { readonly _tag: "All"; readonly children: ReadonlyArray<Policy> } | { readonly _tag: "Any"; readonly children: ReadonlyArray<Policy> }
export type PolicyF<A> = PolicyTerminal | { readonly _tag: "All"; readonly children: ReadonlyArray<A> } | { readonly _tag: "Any"; readonly children: ReadonlyArray<A> }

const PolicySchema: Schema.Codec<Policy> = Schema.suspend(() => Schema.Union([ConstantSchema, EqualSchema, IncludesSchema, AllPolicySchema, AnyPolicySchema]))
const AllPolicySchema = allLayer(PolicySchema)
const AnyPolicySchema = anyLayer(PolicySchema)

export class PolicyEvaluationError extends Schema.TaggedError<PolicyEvaluationError>()("PolicyEvaluationError", { reason: Schema.String }) {}

export class PolicyEnvironment extends Data.Class<{
  readonly subject: StructValue
  readonly row: Option.Option<StructValue>
  readonly next: Option.Option<StructValue>
}> {}

type Algebra<A> = (layer: PolicyF<A>) => A
type Evaluator = (environment: PolicyEnvironment) => Effect.Effect<boolean, PolicyEvaluationError>
type FieldReference = Exclude<Operand, Literal>

const transformLayer = <A, B>(layer: PolicyF<A>, child: (value: A) => B): PolicyF<B> => {
  const transformChildren = (group: Extract<PolicyF<A>, { readonly _tag: "All" | "Any" }>) => {
    const children = Array.map(group.children, child)

    return Struct.assign(group, { children })
  }

  return pipe(
    Match.value(layer),
    Match.tag("All", "Any", transformChildren),
    Match.orElse(Function.identity<PolicyTerminal>),
  )
}

const fold = <A>(algebra: Algebra<A>) => {
  const interpret = (policy: Policy): A => pipe(transformLayer<Policy, A>(policy, interpret), algebra)

  return interpret
}

const literal = <const Value extends Scalar | ReadonlyArray<Scalar>>(value: Value) => {
  const operand = LiteralSchema.make({ value })

  // SAFETY: The literal schema preserves the supplied value because construction does not transform its value field.
  return operand as typeof operand & Readonly<{ readonly value: Value }>
}

const constant = (value: boolean) => ConstantSchema.make({ value })
const all = (...children: ReadonlyArray<Policy>) => AllPolicySchema.make({ children })
const any = (...children: ReadonlyArray<Policy>) => AnyPolicySchema.make({ children })

export const policyFailure = (reason: string): Effect.Effect<never, PolicyEvaluationError> =>
  Effect.fail(PolicyEvaluationError.make({ reason }))

const isScalar = Schema.is(ScalarSchema)
const isScalarCollection = Schema.is(ScalarCollectionSchema)

const valueFrom = (record: Option.Option<StructValue>, source: string, field: string): Effect.Effect<unknown, PolicyEvaluationError> =>
  pipe(
    record,
    Option.match({
      onNone: () => policyFailure(`${source} is unavailable`),
      onSome: (value) => pipe(
        value,
        Record.get(field),
        Option.match({
          onNone: () => policyFailure(`${source}.${field} is unavailable`),
          onSome: Effect.succeed,
        }),
      ),
    }),
  )

const resolve = (operand: Operand, environment: PolicyEnvironment): Effect.Effect<unknown, PolicyEvaluationError> =>
  pipe(
    Match.value(operand),
    Match.tagsExhaustive({
      Literal: ({ value }) => Effect.succeed(value),
      SubjectField: ({ field }) => {
        const subject = Option.some(environment.subject)

        return valueFrom(subject, "subject", field)
      },
      RowField: ({ field }) => valueFrom(environment.row, "row", field),
      NextField: ({ field }) => valueFrom(environment.next, "next", field),
    }),
  )

const resolveAs = <Value>(
  operand: Operand,
  environment: PolicyEnvironment,
  decode: (value: unknown) => Effect.Effect<Value, PolicyEvaluationError>,
): Effect.Effect<Value, PolicyEvaluationError> => pipe(resolve(operand, environment), Effect.flatMap(decode))

const scalar = (value: unknown): Effect.Effect<Scalar, PolicyEvaluationError> =>
  isScalar(value) ? Effect.succeed(value) : policyFailure("policy operand must resolve to a finite scalar")

const collection = (value: unknown): Effect.Effect<ReadonlyArray<Scalar>, PolicyEvaluationError> =>
  isScalarCollection(value) ? Effect.succeed(value) : policyFailure("policy collection must resolve to finite scalar values")

export const resolveScalarLiteralOrSubject = (
  operand: Extract<Operand, { readonly _tag: "Literal" | "SubjectField" }>,
  environment: PolicyEnvironment,
): Effect.Effect<Scalar, PolicyEvaluationError> => resolveAs(operand, environment, scalar)

export const resolveScalarCollectionLiteralOrSubject = (
  operand: Extract<Operand, { readonly _tag: "Literal" | "SubjectField" }>,
  environment: PolicyEnvironment,
): Effect.Effect<ReadonlyArray<Scalar>, PolicyEvaluationError> => resolveAs(operand, environment, collection)

export const resolveScalarOperand = (
  operand: Operand,
  environment: PolicyEnvironment,
): Effect.Effect<Scalar, PolicyEvaluationError> => resolveAs(operand, environment, scalar)

const collectionOperand = (
  operand: Operand,
  environment: PolicyEnvironment,
): Effect.Effect<ReadonlyArray<Scalar>, PolicyEvaluationError> => resolveAs(operand, environment, collection)

const scalarEquals = Equivalence.strictEqual<Scalar>()
const containsScalar = Array.containsWith(scalarEquals)

const evaluateLayer: Algebra<Evaluator> = (layer) =>
  pipe(
    Match.value(layer),
    Match.tagsExhaustive({
      Constant: ({ value }): Evaluator => () => Effect.succeed(value),
      Equal: ({ left, right }) => (environment: PolicyEnvironment) => Effect.gen(function* () {
        const leftValue = yield* resolveScalarOperand(left, environment)
        const rightValue = yield* resolveScalarOperand(right, environment)

        return scalarEquals(leftValue, rightValue)
      }),
      Includes: ({ collection, value }) => (environment: PolicyEnvironment) => Effect.gen(function* () {
        const values = yield* collectionOperand(collection, environment)
        const member = yield* resolveScalarOperand(value, environment)

        return containsScalar(values, member)
      }),
      All: ({ children }) => (environment: PolicyEnvironment) =>
        Effect.reduce(children, () => true, (allowed, child) => allowed ? child(environment) : Effect.succeed(false)),
      Any: ({ children }) => (environment: PolicyEnvironment) =>
        Effect.reduce(children, () => false, (allowed, child) => allowed ? Effect.succeed(true) : child(environment)),
    }),
  )

const evaluate = fold(evaluateLayer)
const isFieldReference = (operand: Operand): operand is FieldReference => !Predicate.isTagged(operand, "Literal")
const referencedOperands = (left: Operand, right: Operand) => Array.filter([left, right], isFieldReference)

const referenceLayer: Algebra<ReadonlyArray<FieldReference>> = (layer) =>
  pipe(
    Match.value(layer),
    Match.tagsExhaustive({
      Constant: Function.constant([]),
      Equal: ({ left, right }) => referencedOperands(left, right),
      Includes: ({ collection, value }) => referencedOperands(collection, value),
      All: ({ children }) => Array.flatten(children),
      Any: ({ children }) => Array.flatten(children),
    }),
  )

const references = fold(referenceLayer)

const renderOperand = (operand: Operand) =>
  pipe(
    Match.value(operand),
    Match.tagsExhaustive({
      Literal: ({ value }) => JSON.stringify(value),
      SubjectField: ({ field }) => `subject.${field}`,
      RowField: ({ field }) => `row.${field}`,
      NextField: ({ field }) => `next.${field}`,
    }),
  )

const renderLayer: Algebra<string> = (layer) =>
  pipe(
    Match.value(layer),
    Match.tagsExhaustive({
      Constant: ({ value }) => String(value),
      Equal: ({ left, right }) => `${renderOperand(left)} == ${renderOperand(right)}`,
      Includes: ({ collection, value }) => `${renderOperand(value)} in ${renderOperand(collection)}`,
      All: ({ children }) => `(${Array.join(children, " && ")})`,
      Any: ({ children }) => `(${Array.join(children, " || ")})`,
    }),
  )

const render = fold(renderLayer)

const freezeOperand = (operand: Operand): Operand => {
  if (!Predicate.isTagged(operand, "Literal")) {
    return pipe(OperandSchema.make({ _tag: operand._tag, field: operand.field }), (snapshot) => Object.freeze(snapshot))
  }

  const value = isScalarCollection(operand.value) ? Object.freeze([...operand.value]) : operand.value

  return pipe(LiteralSchema.make({ value }), (snapshot) => Object.freeze(snapshot))
}

const snapshotLayer: Algebra<Policy> = (layer) => pipe(
  Match.value(layer),
  Match.tagsExhaustive({
    Constant: ({ value }) => ConstantSchema.make({ value }),
    Equal: ({ left, right }) => EqualSchema.make({ left: freezeOperand(left), right: freezeOperand(right) }),
    Includes: ({ collection, value }) => {
      const frozenCollection = freezeOperand(collection)
      const frozenValue = freezeOperand(value)

      return IncludesSchema.make({ collection: frozenCollection, value: frozenValue })
    },
    All: ({ children }) => AllPolicySchema.make({ children: Object.freeze(children) }),
    Any: ({ children }) => AnyPolicySchema.make({ children: Object.freeze(children) }),
  }),
  (policy) => Object.freeze(policy),
)

const snapshot = fold(snapshotLayer)

export const Policy = { Schema: PolicySchema, EqualSchema, IncludesSchema, fold, map: transformLayer, constant, all, any, evaluate, references, render, literal, snapshot }
