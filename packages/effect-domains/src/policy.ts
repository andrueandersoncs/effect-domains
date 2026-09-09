import { Array, Effect, Equivalence, Function, Match, Option, Predicate, Record, Schema, Struct, pipe } from "effect"

export type Scalar = string | number | boolean | null
const ScalarSchema = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null])
const ScalarCollectionSchema = Schema.Array(ScalarSchema)
const LiteralValueSchema = Schema.Union([ScalarSchema, ScalarCollectionSchema])
const LiteralSchema = Schema.TaggedStruct("Literal", { value: LiteralValueSchema })
const SubjectFieldSchema = Schema.TaggedStruct("SubjectField", { field: Schema.String })
const RowFieldSchema = Schema.TaggedStruct("RowField", { field: Schema.String })
const NextFieldSchema = Schema.TaggedStruct("NextField", { field: Schema.String })
export const OperandSchema = Schema.Union([LiteralSchema, SubjectFieldSchema, RowFieldSchema, NextFieldSchema])
export type Operand = Schema.Schema.Type<typeof OperandSchema>
interface Literal extends Schema.Schema.Type<typeof LiteralSchema> {}
const ConstantSchema = Schema.TaggedStruct("Constant", { value: Schema.Boolean })
const EqualSchema = Schema.TaggedStruct("Equal", { left: OperandSchema, right: OperandSchema })
const IncludesSchema = Schema.TaggedStruct("Includes", { collection: OperandSchema, value: OperandSchema })
const PolicyTerminalSchema = Schema.Union([ConstantSchema, EqualSchema, IncludesSchema])
type PolicyTerminal = Schema.Schema.Type<typeof PolicyTerminalSchema>
interface Constant extends Schema.Schema.Type<typeof ConstantSchema> {}
interface Equal extends Schema.Schema.Type<typeof EqualSchema> {}
interface Includes extends Schema.Schema.Type<typeof IncludesSchema> {}
const AllLayerSchema = <A extends Schema.Constraint>(child: A) => Schema.TaggedStruct("All", { children: Schema.Array(child) })
const AnyLayerSchema = <A extends Schema.Constraint>(child: A) => Schema.TaggedStruct("Any", { children: Schema.Array(child) })
type AllLayer<A> = Schema.Schema.Type<ReturnType<typeof AllLayerSchema<Schema.Schema<A>>>>
type AnyLayer<A> = Schema.Schema.Type<ReturnType<typeof AnyLayerSchema<Schema.Schema<A>>>>
export type Policy = PolicyTerminal | { readonly _tag: "All"; readonly children: ReadonlyArray<Policy> } | { readonly _tag: "Any"; readonly children: ReadonlyArray<Policy> }
export type PolicyF<A> = PolicyTerminal | AllLayer<A> | AnyLayer<A>
const PolicySchema: Schema.Codec<Policy> = Schema.suspend(() => Schema.Union([PolicyTerminalSchema, AllPolicySchema, AnyPolicySchema]))
const AllPolicySchema = AllLayerSchema(PolicySchema)
const AnyPolicySchema = AnyLayerSchema(PolicySchema)
export class PolicyEvaluationError extends Schema.TaggedError<PolicyEvaluationError>()("PolicyEvaluationError", { reason: Schema.String }) {}

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const OptionalUnknownRecordSchema = Schema.Option(UnknownRecordSchema)

export class PolicyEnvironment extends Schema.Class<PolicyEnvironment>("PolicyEnvironment")({
  subject: UnknownRecordSchema,
  row: OptionalUnknownRecordSchema,
  next: OptionalUnknownRecordSchema,
}) {}

type Algebra<A> = (layer: PolicyF<A>) => A
type Evaluator = (environment: PolicyEnvironment) => Effect.Effect<boolean, PolicyEvaluationError>

const transformPolicyLayer = <A, B>(layer: PolicyF<A>, transform: (child: A) => B) => {
  const transformedChildren = (node: AllLayer<A> | AnyLayer<A>) => {
    const children = Array.map(node.children, transform)
    return Struct.assign(node, { children })
  }

  return pipe(
    Match.value(layer),
    Match.tagsExhaustive({
      Constant: (node) => node,
      Equal: (node) => node,
      Includes: (node) => node,
      All: transformedChildren,
      Any: transformedChildren,
    }),
  )
}

const fold = <A>(algebra: Algebra<A>) => {
  const foldPolicy: (policy: Policy) => A = (policy) => pipe(transformPolicyLayer(policy, foldPolicy), algebra)

  return foldPolicy
}

const literal = (value: Scalar | ReadonlyArray<Scalar>) => LiteralSchema.make({ value })
const constant = (value: boolean) => ConstantSchema.make({ value })
const all = (...children: ReadonlyArray<Policy>) => AllPolicySchema.make({ children })
const any = (...children: ReadonlyArray<Policy>) => AnyPolicySchema.make({ children })
const evaluationFailure = (reason: string) => pipe(PolicyEvaluationError.make({ reason }), Effect.fail)
const isScalar = Schema.is(ScalarSchema)
const isScalarCollection = Schema.is(ScalarCollectionSchema)

const recordValue = (record: Option.Option<Readonly<Record<string, unknown>>>, source: string, field: string) =>
  pipe(
    record,
    Option.match({
      onNone: () => evaluationFailure(`${source} is unavailable`),
      onSome: (value) =>
        Record.has(value, field)
          ? Effect.succeed(value[field])
          : evaluationFailure(`${source}.${field} is unavailable`),
    }),
  )

const resolveOperand = (operand: Operand, environment: PolicyEnvironment) =>
  pipe(
    Match.value(operand),
    Match.tagsExhaustive({
      Literal: ({ value }) => Effect.succeed(value),
      SubjectField: ({ field }) => {
        const subject = Option.some(environment.subject)
        return recordValue(subject, "subject", field)
      },
      RowField: ({ field }) => recordValue(environment.row, "row", field),
      NextField: ({ field }) => recordValue(environment.next, "next", field),
    }),
  )

const scalarValue = (value: unknown) => (isScalar(value) ? Effect.succeed(value) : evaluationFailure("policy operand must resolve to a finite scalar"))
const scalarCollectionValue = (value: unknown) => (isScalarCollection(value) ? Effect.succeed(value) : evaluationFailure("policy collection must resolve to finite scalar values"))

export const resolveScalarLiteralOrSubject = Effect.fn("Policy.resolveScalarLiteralOrSubject")(
  function* (
    operand: Extract<Operand, { readonly _tag: "Literal" | "SubjectField" }>,
    environment: PolicyEnvironment,
  ) {
    return yield* pipe(resolveOperand(operand, environment), Effect.flatMap(scalarValue))
  },
)

export const resolveScalarCollectionLiteralOrSubject = Effect.fn("Policy.resolveScalarCollectionLiteralOrSubject")(
  function* (
    operand: Extract<Operand, { readonly _tag: "Literal" | "SubjectField" }>,
    environment: PolicyEnvironment,
  ) {
    return yield* pipe(resolveOperand(operand, environment), Effect.flatMap(scalarCollectionValue))
  },
)

const scalarOperand = (operand: Operand, environment: PolicyEnvironment) => pipe(resolveOperand(operand, environment), Effect.flatMap(scalarValue))
const scalarCollectionOperand = (operand: Operand, environment: PolicyEnvironment) => pipe(resolveOperand(operand, environment), Effect.flatMap(scalarCollectionValue))
const scalarEquals = Equivalence.strictEqual<Scalar>()
const containsScalar = Array.containsWith(scalarEquals)
const allInitial = Function.constant(true)
const anyInitial = Function.constant(false)
const evaluateConstant = ({ value }: Constant) => pipe(Effect.succeed(value), Function.constant)

const evaluateEqual = ({ left, right }: Equal) =>
  Effect.fn("Policy.equal")(function* (environment: PolicyEnvironment) {
    const leftValue = yield* scalarOperand(left, environment)
    const rightValue = yield* scalarOperand(right, environment)
    return scalarEquals(leftValue, rightValue)
  })

const evaluateIncludes = ({ collection, value }: Includes) =>
  Effect.fn("Policy.includes")(function* (environment: PolicyEnvironment) {
    const collectionValue = yield* scalarCollectionOperand(collection, environment)
    const valueOperand = yield* scalarOperand(value, environment)
    return containsScalar(collectionValue, valueOperand)
  })

const evaluateAll = ({ children }: AllLayer<Evaluator>) =>
  Effect.fn("Policy.all")(function* (environment: PolicyEnvironment) {
    const evaluateChild = (allowed: boolean, child: Evaluator) => (allowed ? child(environment) : Effect.succeed(false))
    return yield* Effect.reduce(children, allInitial, evaluateChild)
  })

const evaluateAny = ({ children }: AnyLayer<Evaluator>) =>
  Effect.fn("Policy.any")(function* (environment: PolicyEnvironment) {
    const evaluateChild = (allowed: boolean, child: Evaluator) => (allowed ? Effect.succeed(true) : child(environment))
    return yield* Effect.reduce(children, anyInitial, evaluateChild)
  })

const evaluateLayer: Algebra<Evaluator> = (layer) =>
  pipe(
    Match.value(layer),
    Match.tagsExhaustive({
      Constant: evaluateConstant,
      Equal: evaluateEqual,
      Includes: evaluateIncludes,
      All: evaluateAll,
      Any: evaluateAny,
    }),
  )

const evaluate = fold(evaluateLayer)
type FieldReference = Exclude<Operand, Literal>
const fieldReference = (operand: Operand) => (Predicate.isTagged(operand, "Literal") ? Option.none<FieldReference>() : Option.some(operand))
const fieldReferences = Function.flow(Array.map(fieldReference), Array.getSomes)

const referencesLayer: Algebra<ReadonlyArray<FieldReference>> = (layer) =>
  pipe(
    Match.value(layer),
    Match.tagsExhaustive({
      Constant: Function.constant([]),
      Equal: ({ left, right }) => fieldReferences([left, right]),
      Includes: ({ collection, value }) => fieldReferences([collection, value]),
      All: ({ children }) => Array.flatten(children),
      Any: ({ children }) => Array.flatten(children),
    }),
  )

const references = fold(referencesLayer)

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

export const Policy = {
  Schema: PolicySchema,
  fold,
  map: transformPolicyLayer,
  constant,
  all,
  any,
  evaluate,
  references,
  render,
  literal,
}
