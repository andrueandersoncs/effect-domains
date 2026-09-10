import { Array, Effect, Equivalence, Function, Match, Option, Predicate, Record, Schema, Struct, pipe } from "effect"

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

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const OptionalRecordSchema = Schema.Option(UnknownRecordSchema)

export class PolicyEnvironment extends Schema.Class<PolicyEnvironment>("PolicyEnvironment")({
  subject: UnknownRecordSchema,
  row: OptionalRecordSchema,
  next: OptionalRecordSchema,
}) {}

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
  const interpret = (policy: Policy) => pipe(transformLayer<Policy, A>(policy, interpret), algebra)
  return interpret
}

const literal = (value: Scalar | ReadonlyArray<Scalar>) => LiteralSchema.make({ value })
const constant = (value: boolean) => ConstantSchema.make({ value })
const all = (...children: ReadonlyArray<Policy>) => AllPolicySchema.make({ children })
const any = (...children: ReadonlyArray<Policy>) => AnyPolicySchema.make({ children })

export const policyFailure = Effect.fn("Policy.failure")(function* (reason: string) {
  const error = PolicyEvaluationError.make({ reason })
  return yield* Effect.fail(error)
})

const isScalar = Schema.is(ScalarSchema)
const isScalarCollection = Schema.is(ScalarCollectionSchema)

const valueFrom = (record: Option.Option<Readonly<Record<string, unknown>>>, source: string, field: string) =>
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

const resolve = (operand: Operand, environment: PolicyEnvironment) =>
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

const resolveAs = <Value>(operand: Operand, environment: PolicyEnvironment, decode: (value: unknown) => Effect.Effect<Value, PolicyEvaluationError>) =>
  pipe(resolve(operand, environment), Effect.flatMap(decode))

const scalar = (value: unknown) => isScalar(value) ? Effect.succeed(value) : policyFailure("policy operand must resolve to a finite scalar")
const collection = (value: unknown) => isScalarCollection(value) ? Effect.succeed(value) : policyFailure("policy collection must resolve to finite scalar values")

export const resolveScalarLiteralOrSubject = Effect.fn("Policy.resolveScalarLiteralOrSubject")(function* (
  operand: Extract<Operand, { readonly _tag: "Literal" | "SubjectField" }>,
  environment: PolicyEnvironment,
) {
  return yield* resolveAs(operand, environment, scalar)
})

export const resolveScalarCollectionLiteralOrSubject = Effect.fn("Policy.resolveScalarCollectionLiteralOrSubject")(function* (
  operand: Extract<Operand, { readonly _tag: "Literal" | "SubjectField" }>,
  environment: PolicyEnvironment,
) {
  return yield* resolveAs(operand, environment, collection)
})

const scalarOperand = (operand: Operand, environment: PolicyEnvironment) => resolveAs(operand, environment, scalar)
const collectionOperand = (operand: Operand, environment: PolicyEnvironment) => resolveAs(operand, environment, collection)
const scalarEquals = Equivalence.strictEqual<Scalar>()
const containsScalar = Array.containsWith(scalarEquals)

const evaluateLayer: Algebra<Evaluator> = (layer) =>
  pipe(
    Match.value(layer),
    Match.tagsExhaustive({
      Constant: ({ value }) => pipe(Effect.succeed(value), Function.constant),
      Equal: ({ left, right }) => Effect.fn("Policy.equal")(function* (environment: PolicyEnvironment) {
        const leftValue = yield* scalarOperand(left, environment)
        const rightValue = yield* scalarOperand(right, environment)
        return scalarEquals(leftValue, rightValue)
      }),
      Includes: ({ collection, value }) => Effect.fn("Policy.includes")(function* (environment: PolicyEnvironment) {
        const values = yield* collectionOperand(collection, environment)
        const member = yield* scalarOperand(value, environment)
        return containsScalar(values, member)
      }),
      All: ({ children }) => Effect.fn("Policy.all")(function* (environment: PolicyEnvironment) {
        return yield* Effect.reduce(children, Function.constant(true), (allowed, child) => allowed ? child(environment) : Effect.succeed(false))
      }),
      Any: ({ children }) => Effect.fn("Policy.any")(function* (environment: PolicyEnvironment) {
        return yield* Effect.reduce(children, Function.constant(false), (allowed, child) => allowed ? Effect.succeed(true) : child(environment))
      }),
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

const freezeOperand = (operand: Operand) =>
  pipe(
    Match.value(operand),
    Match.tagsExhaustive({
      Literal: ({ value }) => {
        const frozenValue = isScalarCollection(value) ? Object.freeze([...value]) : value
        const literalOperand = OperandSchema.make({ _tag: "Literal", value: frozenValue })
        return Object.freeze(literalOperand)
      },
      SubjectField: ({ field }) => pipe(OperandSchema.make({ _tag: "SubjectField", field }), (value) => Object.freeze(value)),
      RowField: ({ field }) => pipe(OperandSchema.make({ _tag: "RowField", field }), (value) => Object.freeze(value)),
      NextField: ({ field }) => pipe(OperandSchema.make({ _tag: "NextField", field }), (value) => Object.freeze(value)),
    }),
  )

const snapshotLayer: Algebra<Policy> = (layer) =>
  pipe(
    Match.value(layer),
    Match.tagsExhaustive({
      Constant: ({ value }) => pipe(PolicySchema.make({ _tag: "Constant", value }), (policy) => Object.freeze(policy)),
      Equal: ({ left, right }) => pipe(PolicySchema.make({ _tag: "Equal", left: freezeOperand(left), right: freezeOperand(right) }), (policy) => Object.freeze(policy)),
      Includes: ({ collection, value }) => pipe(PolicySchema.make({ _tag: "Includes", collection: freezeOperand(collection), value: freezeOperand(value) }), (policy) => Object.freeze(policy)),
      All: ({ children }) => {
        const frozenChildren = Object.freeze(children)
        const policy = PolicySchema.make({ _tag: "All", children: frozenChildren })
        return Object.freeze(policy)
      },
      Any: ({ children }) => {
        const frozenChildren = Object.freeze(children)
        const policy = PolicySchema.make({ _tag: "Any", children: frozenChildren })
        return Object.freeze(policy)
      },
    }),
  )

const snapshot = fold(snapshotLayer)

export const Policy = { Schema: PolicySchema, fold, map: transformLayer, constant, all, any, evaluate, references, render, literal, snapshot }
