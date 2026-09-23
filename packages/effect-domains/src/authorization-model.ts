import { Array, Context, Data, Effect, Equivalence, Function, HashSet, Option, Predicate, Record, Schema, SchemaAST, Struct, flow, pipe } from "effect"
import type { StructSchema, StructValue } from "./domain.ts"
import { EntitlementRequired, EntitlementUnavailable } from "./entitlements.ts"
import { OperandSchema, Policy, type Operand, type Policy as PolicySyntax, type Scalar, PolicyEvaluationError } from "./policy.ts"
import type { FieldIR } from "./schema-field.ts"

export class AuthorizationSubject extends Context.Service<AuthorizationSubject, StructValue>()("@effect-domains/AuthorizationSubject") {}
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()("Unauthenticated", {}) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}) {}
class AuthorizationDefinitionError extends Schema.TaggedError<AuthorizationDefinitionError>()("AuthorizationDefinitionError", { reason: Schema.String }) {}

type FieldName<S extends StructSchema> = Extract<keyof S["fields"], string>
type FieldValue<S extends StructSchema, Key extends FieldName<S>> = S["Type"][Key]
type ScalarOnlyFieldName<S extends StructSchema> = { readonly [Key in FieldName<S>]: FieldValue<S, Key> extends Scalar ? Key : never }[FieldName<S>]
type PolicyPhase = "subject" | "row" | "next"

declare const PolicyPhases: unique symbol

type PolicyExpression<Phases extends PolicyPhase = PolicyPhase> = PolicySyntax & Readonly<Record<typeof PolicyPhases, readonly [never, Phases]>>
type TypedOperand<Value, Phases extends PolicyPhase> = Operand & Readonly<Record<typeof PolicyPhases, readonly [Value, Phases]>>

export type SubjectOperand<Value> = TypedOperand<Value, "subject"> & Readonly<{ readonly _tag: "SubjectField" }>

type FieldReferences<S extends StructSchema, Tag extends Operand["_tag"], Phases extends PolicyPhase> = {
  readonly [Key in FieldName<S>]: FieldValue<S, Key> extends Scalar | ReadonlyArray<Scalar> ? TypedOperand<FieldValue<S, Key>, Phases> & Readonly<{ readonly _tag: Tag }> : never
}

type OperandPhases<Value> = Value extends TypedOperand<unknown, PolicyPhase> ? Value[typeof PolicyPhases][1] : never
type OperandValue<Value> = Value extends TypedOperand<unknown, PolicyPhase> ? Value[typeof PolicyPhases][0] : Value
type CollectionValue<Value> = OperandValue<Value> extends ReadonlyArray<infer Element> ? Element : never
type ExpressionPhase<Expression> = Expression extends PolicyExpression ? Expression[typeof PolicyPhases][1] : never
type ScalarOperand = TypedOperand<Scalar, PolicyPhase> | Scalar
type ScalarCollection = TypedOperand<ReadonlyArray<Scalar>, PolicyPhase> | ReadonlyArray<Scalar>
type ScalarKind<Value> = Exclude<Value, null> extends string ? "string" : Exclude<Value, null> extends number ? "number" : Exclude<Value, null> extends boolean ? "boolean" : never
type Comparable<Left, Right> = [Exclude<Left, null>] extends [never] ? unknown : [Exclude<Right, null>] extends [never] ? unknown : ScalarKind<Left> extends ScalarKind<Right> ? unknown : never
type Included<Collection, Value> = [OperandValue<Value>] extends [CollectionValue<Collection>] ? unknown : never

export type AuthorizationAction = keyof typeof PolicyRulesSchema.fields

const isStruct = <Value>(value: Value): value is Value & StructSchema => Schema.isSchema(value) && SchemaAST.isObjects(value.ast)

const PublicAuthorizationSchema = Schema.TaggedStruct("Public", {})
const DenyAuthorizationSchema = Schema.TaggedStruct("Deny", {})

type FieldDescriptions = Readonly<Record<string, Option.Option<FieldIR>>>

class PolicyFields extends Data.Class<{
  readonly resource: FieldDescriptions
  readonly subject: FieldDescriptions
}> {}

export class AuthorizationValues extends Data.Class<{
  readonly row: Option.Option<StructValue>
  readonly next: Option.Option<StructValue>
}> {}

const StructValueSchema = Schema.declare(isStruct)
const OptionalPolicySchema = Schema.optionalKey(Policy.Schema)

const PolicyRulesSchema = Schema.Struct({
  read: OptionalPolicySchema,
  create: OptionalPolicySchema,
  update: OptionalPolicySchema,
  patch: OptionalPolicySchema,
  transition: OptionalPolicySchema,
  remove: OptionalPolicySchema,
}).annotate({ parseOptions: { onExcessProperty: "error" } })

interface PolicyRules extends Schema.Schema.Type<typeof PolicyRulesSchema> {}

export const EntitlementRequirementSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  key: OperandSchema,
}).annotate({ parseOptions: { onExcessProperty: "error" } })

interface EntitlementRequirement extends Schema.Schema.Type<typeof EntitlementRequirementSchema> {}

type TypedEntitlement<Phases extends PolicyPhase = PolicyPhase> = EntitlementRequirement & Readonly<Record<typeof PolicyPhases, readonly [never, Phases]>>

const EntitlementListSchema = Schema.Array(EntitlementRequirementSchema)
const OptionalEntitlementListSchema = Schema.optionalKey(EntitlementListSchema)

export const EntitlementRequirementsSchema = Schema.Struct({
  read: OptionalEntitlementListSchema,
  create: OptionalEntitlementListSchema,
  update: OptionalEntitlementListSchema,
  patch: OptionalEntitlementListSchema,
  transition: OptionalEntitlementListSchema,
  remove: OptionalEntitlementListSchema,
}).annotate({ parseOptions: { onExcessProperty: "error" } })

interface EntitlementRequirements extends Schema.Schema.Type<typeof EntitlementRequirementsSchema> {}

const emptyEntitlementRequirements = EntitlementRequirementsSchema.make({})
const emptyEntitlements: ReadonlyArray<EntitlementRequirement> = Object.freeze([])

type EntitlementMap = Readonly<Partial<Record<string, ReadonlyArray<EntitlementRequirement>>>>

type EntitlementPhases<Action extends AuthorizationAction> = Action extends "create" ? "next" | "subject" : Action extends "read" | "remove" ? "row" | "subject" : PolicyPhase

type TypedEntitlementRequirements = Readonly<Partial<{
  [Action in AuthorizationAction]: ReadonlyArray<TypedEntitlement<EntitlementPhases<Action>>>
}>>

const PolicyAuthorizationSchema = Schema.TaggedStruct("Policy", {
  resource: StructValueSchema,
  subject: StructValueSchema,
  scope: Policy.Schema,
  allow: PolicyRulesSchema,
  require: Schema.optionalKey(EntitlementRequirementsSchema),
})

export interface PolicyAuthorization<Resource extends StructSchema = StructSchema, Subject extends StructSchema = StructSchema> extends Schema.Schema.Type<typeof PolicyAuthorizationSchema> {
  readonly resource: Resource
  readonly subject: Subject
}

export interface SubjectPolicy<Subject extends StructSchema = StructSchema, Requirements extends ReadonlyArray<EntitlementRequirement> = ReadonlyArray<EntitlementRequirement>> {
  readonly subject: Subject
  readonly expression: PolicyExpression<"subject">
  readonly require: Requirements
}


export type AuthorizationDefinition = Schema.Schema.Type<typeof PublicAuthorizationSchema> | Schema.Schema.Type<typeof DenyAuthorizationSchema> | PolicyAuthorization

export interface AuthorizationRuntime {
  readonly visibility: PolicySyntax
  readonly subject: (action: AuthorizationAction) => Effect.Effect<StructValue, Unauthenticated | Forbidden | EntitlementRequired | EntitlementUnavailable, AuthorizationSubject>
  readonly check: (action: AuthorizationAction, subject: StructValue, values: AuthorizationValues) => Effect.Effect<void, Forbidden | PolicyEvaluationError | EntitlementRequired | EntitlementUnavailable, never>
}

const publicAuthorization = PublicAuthorizationSchema.make({})
const denyAuthorization = DenyAuthorizationSchema.make({})

const equals = Function.dual<
  (right: unknown) => (left: unknown) => boolean,
  (left: unknown, right: unknown) => boolean
>(2, Equivalence.strictEqual<unknown>())

const actions = Struct.keys(PolicyRulesSchema.fields)
const scopePhases = HashSet.fromIterable<PolicyPhase>(["row", "subject"])
const createPhases = HashSet.fromIterable<PolicyPhase>(["next", "subject"])
const changePhases = HashSet.fromIterable<PolicyPhase>(["row", "next", "subject"])
const truePolicy = Policy.constant(true)
const falsePolicy = Policy.constant(false)
const defaultReadPolicy = Function.constant(falsePolicy)
const definitionError = (reason: string) => AuthorizationDefinitionError.make({ reason })

const failure = flow(definitionError, Effect.fail)

const forbiddenError = Forbidden.make({})
const unauthenticatedError = Unauthenticated.make({})
const forbiddenEffect = Effect.fail(forbiddenError)
const unauthenticatedEffect = Effect.fail(unauthenticatedError)
const forbidden = Function.constant(forbiddenEffect)
const unauthenticated = Function.constant(unauthenticatedEffect)
const isPublicAuthorization = Schema.is(PublicAuthorizationSchema)
const isDenyAuthorization = Schema.is(DenyAuthorizationSchema)
const isPolicyAuthorization = <Value>(value: Value): value is Value & PolicyAuthorization => Predicate.isTagged(value, "Policy")

const literalOperand = <Value extends Scalar | ReadonlyArray<Scalar>>(value: Value) => {
  const literal = Policy.literal(value)

  // SAFETY: The phantom phase is type-only because literal operands do not read any policy environment phase.
  return literal as typeof literal & Readonly<Record<typeof PolicyPhases, readonly [Value, never]>>
}

// SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
const operand = <Value extends Scalar>(value: TypedOperand<Value, PolicyPhase> | Value) => {
  if (Predicate.hasProperty(value, "_tag")) return value as TypedOperand<Value, PolicyPhase>
  return literalOperand(value)
}
// SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
const collectionOperand = <Value extends Scalar>(value: TypedOperand<ReadonlyArray<Value>, PolicyPhase> | ReadonlyArray<Value>) => {
  if (Predicate.hasProperty(value, "_tag")) return value as TypedOperand<ReadonlyArray<Value>, PolicyPhase>
  return literalOperand(value)
}
// SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
const expression = <Phases extends PolicyPhase>(policy: PolicySyntax) => policy as PolicyExpression<Phases>

const policyField = <Value, Tag extends "SubjectField" | "RowField" | "NextField", Phases extends PolicyPhase>(tag: Tag, field: string) =>
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  OperandSchema.make({ _tag: tag, field }) as TypedOperand<Value, Phases> & Readonly<{ readonly _tag: Tag }>

const policyFields = <S extends StructSchema, Tag extends "SubjectField" | "RowField" | "NextField", Phases extends PolicyPhase>(schema: S, tag: Tag) =>
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  Record.map(schema.fields, (_, field) => policyField(tag, field)) as FieldReferences<S, Tag, Phases>

const eq = <Left extends ScalarOperand, Right extends ScalarOperand>(left: Left, right: Right & Comparable<OperandValue<Left>, OperandValue<Right>>) => {
  const leftOperand = operand(left)
  const rightOperand = operand(right)

  return pipe(
    Policy.EqualSchema.make({ left: leftOperand, right: rightOperand }),
    expression<OperandPhases<Left> | OperandPhases<Right>>,
  )
}

const membership = <Collection extends ScalarCollection, Value extends ScalarOperand>(collection: Collection, value: Value & Comparable<CollectionValue<Collection>, OperandValue<Value>> & Included<Collection, Value>) => {
  const collectionReference = collectionOperand(collection)
  const valueOperand = operand(value)

  return pipe(
    Policy.IncludesSchema.make({ collection: collectionReference, value: valueOperand }),
    expression<OperandPhases<Collection> | OperandPhases<Value>>,
  )
}

const all = <const Expressions extends ReadonlyArray<PolicyExpression>>(...children: Expressions) =>
  pipe(Policy.all(...children), expression<ExpressionPhase<Expressions[number]>>)

const any = <const Expressions extends ReadonlyArray<PolicyExpression>>(...children: Expressions) =>
  pipe(Policy.any(...children), expression<ExpressionPhase<Expressions[number]>>)

const entitlement = <Key extends TypedOperand<string, PolicyPhase> | string>(requirement: Readonly<{ name: string; key: Key }>) =>
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  EntitlementRequirementSchema.make({ name: requirement.name, key: operand(requirement.key) }) as TypedEntitlement<OperandPhases<Key>>


export {
  all,
  type Comparable,
  any,
  actions,
  AuthorizationDefinitionError,
  changePhases,
  createPhases,
  defaultReadPolicy,
  definitionError,
  denyAuthorization,
  emptyEntitlementRequirements,
  EntitlementListSchema,
  entitlement,
  emptyEntitlements,
  equals,
  expression,
  eq,
  failure,
  falsePolicy,
  type FieldDescriptions,
  type EntitlementMap,
  type EntitlementRequirement,
  type EntitlementRequirements,
  forbidden,
  forbiddenError,
  isDenyAuthorization,
  isPolicyAuthorization,
  isPublicAuthorization,
  literalOperand,
  membership,
  policyFields,
  type FieldName,
  type FieldValue,
  isStruct,
  type PolicyExpression,
  PolicyFields,
  type PolicyPhase,
  PolicyAuthorizationSchema,
  publicAuthorization,
  scopePhases,
  truePolicy,
  type ScalarOnlyFieldName,
  type TypedEntitlement,
  type TypedEntitlementRequirements,
  unauthenticatedError,
}
