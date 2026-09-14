import { Array, Context, Data, Effect, Equivalence, Function, HashSet, Match, Option, Predicate, Record, Schema, SchemaAST, Struct, flow, pipe } from "effect"
import { type StructSchema } from "./domain.ts"
import { OperandSchema, Policy, PolicyEnvironment, resolveScalarOperand, type Operand, type Policy as PolicySyntax, type PolicyF, PolicyEvaluationError, type Scalar } from "./policy.ts"
import type { Table } from "./table.ts"
import { FieldIR, SchemaField, type FieldCategory } from "./schema-field.ts"
import { Entitlements, EntitlementRequired, EntitlementUnavailable } from "./entitlements.ts"

export class AuthorizationSubject extends Context.Service<AuthorizationSubject, Readonly<Record<string, unknown>>>()("@effect-domains/AuthorizationSubject") {}
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

const isStruct = (value: unknown): value is StructSchema => Schema.isSchema(value) && SchemaAST.isObjects(value.ast)

const PublicAuthorizationSchema = Schema.TaggedStruct("Public", {})
const DenyAuthorizationSchema = Schema.TaggedStruct("Deny", {})
type FieldDescriptions = Readonly<Record<string, Option.Option<FieldIR>>>

class PolicyFields extends Data.Class<{
  readonly resource: FieldDescriptions
  readonly subject: FieldDescriptions
}> {}

export class AuthorizationValues extends Data.Class<{
  readonly row: Option.Option<Readonly<Record<string, unknown>>>
  readonly next: Option.Option<Readonly<Record<string, unknown>>>
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

type TypedEntitlementRequirements = Readonly<Partial<{
  [Action in AuthorizationAction]: ReadonlyArray<TypedEntitlement<
    Action extends "create" ? "next" | "subject" : Action extends "read" | "remove" ? "row" | "subject" : PolicyPhase
  >>
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
  readonly subject: (action: AuthorizationAction) => Effect.Effect<Readonly<Record<string, unknown>>, Unauthenticated | Forbidden | EntitlementRequired | EntitlementUnavailable>
  readonly check: (action: AuthorizationAction, subject: Readonly<Record<string, unknown>>, values: AuthorizationValues) => Effect.Effect<void, Forbidden | PolicyEvaluationError | EntitlementRequired | EntitlementUnavailable>
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
const isPolicyAuthorization = (value: unknown): value is PolicyAuthorization => Predicate.isTagged(value, "Policy")

const literalOperand = <Value extends Scalar | ReadonlyArray<Scalar>>(value: Value) => OperandSchema.make({ _tag: "Literal", value }) as TypedOperand<Value, never>
const operand = <Value extends Scalar>(value: TypedOperand<Value, PolicyPhase> | Value) => Predicate.hasProperty(value, "_tag") ? value as TypedOperand<Value, PolicyPhase> : literalOperand(value) as TypedOperand<Value, PolicyPhase>
const collectionOperand = <Value extends Scalar>(value: TypedOperand<ReadonlyArray<Value>, PolicyPhase> | ReadonlyArray<Value>) => Predicate.hasProperty(value, "_tag") ? value as TypedOperand<ReadonlyArray<Value>, PolicyPhase> : literalOperand(value) as TypedOperand<ReadonlyArray<Value>, PolicyPhase>
const expression = <Phases extends PolicyPhase>(policy: PolicySyntax) => policy as PolicyExpression<Phases>

const policyField = <Value, Tag extends "SubjectField" | "RowField" | "NextField", Phases extends PolicyPhase>(tag: Tag, field: string) =>
  OperandSchema.make({ _tag: tag, field }) as TypedOperand<Value, Phases> & Readonly<{ readonly _tag: Tag }>

const policyFields = <S extends StructSchema, Tag extends "SubjectField" | "RowField" | "NextField", Phases extends PolicyPhase>(schema: S, tag: Tag) =>
  Record.map(schema.fields, (_, field) => policyField(tag, field)) as FieldReferences<S, Tag, Phases>

const eq = <Left extends ScalarOperand, Right extends ScalarOperand>(left: Left, right: Right & Comparable<OperandValue<Left>, OperandValue<Right>>) => pipe(
  Policy.Schema.make({ _tag: "Equal", left: operand(left), right: operand(right) }),
  expression<OperandPhases<Left> | OperandPhases<Right>>,
)

const membership = <Collection extends ScalarCollection, Value extends ScalarOperand>(collection: Collection, value: Value & Comparable<CollectionValue<Collection>, OperandValue<Value>> & Included<Collection, Value>) => pipe(
  Policy.Schema.make({ _tag: "Includes", collection: collectionOperand(collection), value: operand(value) }),
  expression<OperandPhases<Collection> | OperandPhases<Value>>,
)

const all = <const Expressions extends ReadonlyArray<PolicyExpression>>(...children: Expressions) =>
  pipe(Policy.all(...children), expression<ExpressionPhase<Expressions[number]>>)

const any = <const Expressions extends ReadonlyArray<PolicyExpression>>(...children: Expressions) =>
  pipe(Policy.any(...children), expression<ExpressionPhase<Expressions[number]>>)

const entitlement = <Key extends TypedOperand<string, PolicyPhase> | string>(requirement: Readonly<{ name: string; key: Key }>) =>
  EntitlementRequirementSchema.make({ name: requirement.name, key: operand(requirement.key) }) as TypedEntitlement<OperandPhases<Key>>

const policyDsl = <Resource extends StructSchema, Subject extends StructSchema>(schemas: Readonly<{ readonly resource: Resource; readonly subject: Subject }>) => {
  const subject = policyFields<Subject, "SubjectField", "subject">(schemas.subject, "SubjectField")
  const row = policyFields<Resource, "RowField", "row">(schemas.resource, "RowField")
  const next = policyFields<Resource, "NextField", "next">(schemas.resource, "NextField")

  const sameAs = <Field extends FieldName<Resource> & FieldName<Subject>>(
    field: Field & (FieldValue<Resource, Field> extends Scalar
      ? FieldValue<Subject, Field> extends Scalar
        ? Comparable<FieldValue<Resource, Field>, FieldValue<Subject, Field>>
        : never
      : never),
  ) => pipe(
    Policy.Schema.make({ _tag: "Equal", left: row[field] as Operand, right: subject[field] as Operand }),
    expression<"row" | "subject">,
  )

  const unchangedField = (field: ScalarOnlyFieldName<Resource>) => Policy.Schema.make({ _tag: "Equal", left: row[field] as Operand, right: next[field] as Operand })

  const unchanged = (...fields: ReadonlyArray<ScalarOnlyFieldName<Resource>>) => {
    const comparisons = Array.map(fields, unchangedField)
    return pipe(Policy.all(...comparisons), expression<"row" | "next">)
  }

  const policy = <Allow extends Partial<{
    readonly read: PolicyExpression<"row" | "subject"> | SubjectPolicy<Subject>
    readonly create: PolicyExpression<"next" | "subject"> | SubjectPolicy<Subject>
    readonly update: PolicyExpression<"row" | "next" | "subject"> | SubjectPolicy<Subject>
    readonly patch: PolicyExpression<"row" | "next" | "subject"> | SubjectPolicy<Subject>
    readonly transition: PolicyExpression<"row" | "next" | "subject"> | SubjectPolicy<Subject>
    readonly remove: PolicyExpression<"row" | "subject"> | SubjectPolicy<Subject>
  }>>(definition: Readonly<{ readonly scope: PolicyExpression<"row" | "subject"> | SubjectPolicy<Subject>; readonly allow: Allow }> & Readonly<Partial<{ require: Pick<TypedEntitlementRequirements, Extract<keyof NoInfer<Allow>, AuthorizationAction>> }>>) => constructPolicy(schemas.resource, schemas.subject, definition)

  return { subject, row, next, eq, includes: membership, all, any, sameAs, unchanged, policy, entitlement, literal: literalOperand }
}

const subjectPolicyDsl = <Subject extends StructSchema>(subject: Subject) => {
  const subjectFields = describeFields(subject)
  const fields = new PolicyFields({ resource: {}, subject: subjectFields })
  const isSubject = Schema.is(subject)

  const policy = <const Requirements extends ReadonlyArray<TypedEntitlement<"subject">> = readonly []>(
    condition: PolicyExpression<"subject">,
    options: Readonly<Partial<{ require: Requirements }>> = {},
  ): SubjectPolicy<Subject, Requirements> => {
    pipe(checkPolicy(condition, fields, subjectPhases, "subject policy"), Effect.runSync)
    const decodedRequirements = EntitlementListSchema.make(options.require ?? emptyEntitlements)
    pipe(validateEntitlements(decodedRequirements, fields, subjectPhases), Effect.runSync)
    const required = snapshotEntitlements(decodedRequirements) as Requirements
    const snapshot = pipe(condition, Policy.snapshot, expression<"subject">)
    const evaluate = Policy.evaluate(snapshot)

    const require = Effect.gen(function* () {
      const claims = yield* AuthorizationSubject
      if (!isSubject(claims)) return yield* forbidden()
      const environment = new PolicyEnvironment({ subject: claims, row: absentPolicyRow, next: absentPolicyRow })
      const allowed = yield* pipe(evaluate(environment), Effect.catchTag("PolicyEvaluationError", forbidden))
      if (!allowed) return yield* forbidden()
      yield* pipe(checkEntitlements(required, environment), Effect.catchTag("PolicyEvaluationError", forbidden))
      return claims
    })

    const invalidRegistration = pipe(definitionError("subject policy registration does not match its definition"), Effect.die)
    const registration = (candidate: SubjectPolicy<Subject>) => equals(candidate, registered) ? require : invalidRegistration
    const registered = Object.freeze({ subject, expression: snapshot, require: required, [RegisteredSubjectPolicy]: registration })
    return registered
  }

  return { subject: policyFields<Subject, "SubjectField", "subject">(subject, "SubjectField"), eq, includes: membership, all, any, literal: literalOperand, entitlement, policy }
}

const describeFields = (schema: StructSchema): FieldDescriptions =>
  Record.map(schema.fields, SchemaField.compile)
const fieldFor = (fields: FieldDescriptions, field: string) => pipe(Record.get(fields, field), Option.flatten)

const sameFieldCategory = (left: FieldIR["category"], right: FieldIR["category"]) => {
  const unrestricted = Option.isNone(left) || Option.isNone(right)
  const same = Option.makeEquivalence(equals)(left, right)
  return unrestricted || same
}

const phaseFor = (operand: Exclude<Operand, { readonly _tag: "Literal" }>) => pipe(
  Match.value(operand),
  Match.tag("SubjectField", Function.constant("subject" as const)),
  Match.tag("RowField", Function.constant("row" as const)),
  Match.tag("NextField", Function.constant("next" as const)),
  Match.exhaustive,
)

const describeReference = (operand: Exclude<Operand, { readonly _tag: "Literal" }>, fields: PolicyFields, allowed: HashSet.HashSet<PolicyPhase>) => {
  const phase = phaseFor(operand)
  if (!HashSet.has(allowed, phase)) return failure(`${phase}.${operand.field} is not available in this policy phase`)
  const fieldSchema = equals(phase, "subject") ? fields.subject : fields.resource

  return pipe(fieldFor(fieldSchema, operand.field), Option.match({
    onNone: () => failure(`${phase}.${operand.field} must be a known finite scalar or scalar collection field`),
    onSome: Effect.succeed,
  }))
}

const describeOperand = (operand: Operand, fields: PolicyFields, allowed: HashSet.HashSet<PolicyPhase>) => pipe(
  Match.value(operand),
  Match.tag("Literal", flow(Struct.get<Extract<Operand, { readonly _tag: "Literal" }>, "value">("value"), SchemaField.describeValue, Option.match({
    onNone: () => failure("policy literal must contain only finite scalar values"),
    onSome: Effect.succeed,
  }))),
  Match.orElse((reference) => describeReference(reference, fields, allowed)),
)

const checkPair = Effect.fn("Authorization.checkPair")(function* (
  left: Operand,
  right: Operand,
  fields: PolicyFields,
  allowed: HashSet.HashSet<PolicyPhase>,
  label: string,
  inclusion: boolean,
) {
  const leftDescription = yield* describeOperand(left, fields, allowed)
  const rightDescription = yield* describeOperand(right, fields, allowed)
  const scalarValue = !rightDescription.collection
  const collectionShape = equals(leftDescription.collection, inclusion)
  const validShape = collectionShape && scalarValue
  if (!validShape) return yield* failure(inclusion ? `${label} includes requires a scalar collection and scalar value` : `${label} equality operands must be scalar`)
  if (!sameFieldCategory(leftDescription.category, rightDescription.category)) return yield* failure(`${label} ${inclusion ? "includes" : "equality"} operands must have the same scalar type`)
})

const checkPolicy = (policy: PolicySyntax, fields: PolicyFields, allowed: HashSet.HashSet<PolicyPhase>, label: string) => {
  const validate = (layer: PolicyF<Effect.Effect<void, AuthorizationDefinitionError>>) => pipe(
    Match.value(layer),
    Match.tagsExhaustive({
      Constant: Function.constant(Effect.void),
      Equal: ({ left, right }) => checkPair(left, right, fields, allowed, label, false),
      Includes: ({ collection, value }) => checkPair(collection, value, fields, allowed, label, true),
      All: ({ children }) => Effect.all(children, { discard: true }),
      Any: ({ children }) => Effect.all(children, { discard: true }),
    }),
  )

  return Policy.fold<Effect.Effect<void, AuthorizationDefinitionError>>(validate)(policy)
}

const validateEntitlements = (requirements: ReadonlyArray<EntitlementRequirement>, fields: PolicyFields, phases: HashSet.HashSet<PolicyPhase>) =>
  Effect.forEach(requirements, Effect.fn("Authorization.validateEntitlement")(function* (requirement) {
    const description = yield* describeOperand(requirement.key, fields, phases)
    const stringKey = Option.contains(description.category, "string")
    const invalidShape = description.nullable || description.collection
    const nonString = !stringKey
    const invalidKey = nonString || invalidShape
    if (invalidKey) return yield* failure("entitlement key must be a required string")
  }), { discard: true })

const snapshotEntitlement = ({ name, key }: EntitlementRequirement) => {
  const frozenKey = Object.freeze({ ...key })
  return Object.freeze({ name, key: frozenKey })
}

const snapshotEntitlements = flow(Array.map(snapshotEntitlement), Object.freeze)

const checkEntitlements = (requirements: ReadonlyArray<EntitlementRequirement>, environment: PolicyEnvironment) =>
  Effect.forEach(requirements, Effect.fn("Authorization.entitlement")(function* (requirement) {
    const key = yield* resolveScalarOperand(requirement.key, environment)
    if (!Predicate.isString(key)) return yield* EntitlementUnavailable.make({})
    yield* Entitlements.require({ name: requirement.name, key, subject: environment.subject })
  }), { discard: true })

const subjectEntitlement = (requirement: EntitlementRequirement) =>
  Predicate.isTagged(requirement.key, "Literal") || Predicate.isTagged(requirement.key, "SubjectField")

const requirementsFor = (requirements: EntitlementRequirements, action: AuthorizationAction) => requirements[action] ?? emptyEntitlements

const RegisteredSubjectPolicy = Symbol("RegisteredSubjectPolicy")

type RegisteredSubjectPolicy<Subject extends StructSchema> = SubjectPolicy<Subject> & Readonly<Record<
  typeof RegisteredSubjectPolicy,
  (candidate: SubjectPolicy<Subject>) => Effect.Effect<Subject["Type"], Forbidden | EntitlementRequired | EntitlementUnavailable, AuthorizationSubject>
>>

const isRegisteredSubjectPolicy = <Subject extends StructSchema>(policy: SubjectPolicy<Subject>): policy is RegisteredSubjectPolicy<Subject> =>
  Predicate.hasProperty(policy, RegisteredSubjectPolicy)

const isSubjectPolicy = (value: unknown): value is SubjectPolicy =>
  Predicate.hasProperty(value, "expression")

/** A scope or action expression together with the entitlements a SubjectPolicy contributed. */
class ResolvedPolicy extends Data.Class<{
  readonly expression: PolicySyntax
  readonly require: ReadonlyArray<EntitlementRequirement>
}> {}

class ResolvedAction extends Data.Class<{
  readonly action: AuthorizationAction
  readonly expression: PolicySyntax
  readonly requirements: ReadonlyArray<EntitlementRequirement>
}> {}

class NormalizedDefinition extends Data.Class<{
  readonly scope: PolicySyntax
  readonly allow: Partial<Record<AuthorizationAction, PolicySyntax>>
  readonly require: Option.Option<EntitlementRequirements>
}> {}

const absentResolvedAction = Option.none<ResolvedAction>()
const noResolvedAction = Effect.succeed(absentResolvedAction)
type ResolvedPolicyEffect = Effect.Effect<ResolvedPolicy, AuthorizationDefinitionError>
const unregisteredSubjectPolicy: ResolvedPolicyEffect = failure("subject policy must be constructed by Authorization.subject")
const foreignSubjectPolicy: ResolvedPolicyEffect = failure("subject policy subject schema must match the authorization subject schema")

const resolvedPolicy = (expression: PolicySyntax, require: ReadonlyArray<EntitlementRequirement>): ResolvedPolicyEffect =>
  pipe(new ResolvedPolicy({ expression, require }), Effect.succeed)

const resolveSubjectPolicy = (subject: StructSchema, policy: SubjectPolicy): ResolvedPolicyEffect => {
  const registered = isRegisteredSubjectPolicy(policy)
  const sameSubject = equals(policy.subject, subject)
  const accepted = resolvedPolicy(policy.expression, policy.require)
  const checked = sameSubject ? accepted : foreignSubjectPolicy
  return registered ? checked : unregisteredSubjectPolicy
}

const subjectPolicyExpression = (policy: PolicySyntax | SubjectPolicy, subject: StructSchema) =>
  isSubjectPolicy(policy) ? resolveSubjectPolicy(subject, policy) : resolvedPolicy(policy, emptyEntitlements)

const actionExpression = (resolved: ResolvedAction) => [resolved.action, resolved.expression] as const
const actionRequirementsEntry = (resolved: ResolvedAction) => [resolved.action, resolved.requirements] as const
const hasRequirements = (resolved: ResolvedAction) => Array.isReadonlyArrayNonEmpty(resolved.requirements)

// Merge scope requirements into every allowed action because a hidden row must also fail its gate.
const normalizePolicyDefinition = Effect.fn("Authorization.normalizePolicyDefinition")(function* (
  subject: StructSchema,
  definition: Readonly<{
    readonly scope: PolicySyntax | SubjectPolicy
    readonly allow: Partial<Record<AuthorizationAction, PolicySyntax | SubjectPolicy>>
  }> & Readonly<Partial<{ require: EntitlementRequirements }>>,
) {
  const scope = yield* subjectPolicyExpression(definition.scope, subject)
  const declaredRequirements = definition.require ?? emptyEntitlementRequirements

  const resolveInput = (action: AuthorizationAction) => (input: PolicySyntax | SubjectPolicy) => pipe(
    subjectPolicyExpression(input, subject),
    Effect.map((policy) => {
      const declared = requirementsFor(declaredRequirements, action)
      const inherited = Array.appendAll(declared, scope.require)
      const requirements = Array.appendAll(inherited, policy.require)
      const resolved = new ResolvedAction({ action, expression: policy.expression, requirements })
      return Option.some(resolved)
    }),
  )

  const resolveAction = (action: AuthorizationAction) => pipe(
    Option.fromNullishOr(definition.allow[action]),
    Option.match({ onNone: Function.constant(noResolvedAction), onSome: resolveInput(action) }),
  )

  const resolutions = yield* Effect.forEach(actions, resolveAction)
  const resolved = Array.getSomes(resolutions)
  const allowEntries = Array.map(resolved, actionExpression)
  const allow: Partial<Record<AuthorizationAction, PolicySyntax>> = Record.fromEntries(allowEntries)
  const requiring = Array.filter(resolved, hasRequirements)
  const requireEntries = Array.map(requiring, actionRequirementsEntry)
  const requirements: EntitlementRequirements = Record.fromEntries(requireEntries)
  const anyRequirements = Array.isReadonlyArrayNonEmpty(requiring)
  const require = anyRequirements ? Option.some(requirements) : Option.none<EntitlementRequirements>()
  return new NormalizedDefinition({ scope: scope.expression, allow, require })
})

const subjectPhases = HashSet.fromIterable<PolicyPhase>(["subject"])
const absentPolicyRow = Option.none<Readonly<Record<string, unknown>>>()


const requireSubject = <Subject extends StructSchema, Requirements extends ReadonlyArray<EntitlementRequirement>>(policy: SubjectPolicy<Subject, Requirements>) => {
  const effect = isRegisteredSubjectPolicy(policy)
    ? policy[RegisteredSubjectPolicy](policy)
    : pipe(definitionError("subject policy must be constructed by Authorization.subject"), Effect.die)

  return effect as Effect.Effect<Subject["Type"], Requirements extends readonly [] ? Forbidden : Forbidden | EntitlementRequired | EntitlementUnavailable, AuthorizationSubject>
}

const policyFor = (authorization: PolicyAuthorization, action: AuthorizationAction) => Option.fromNullishOr(authorization.allow[action])

const readRequirements = [scopePhases, true, false] as const
const createRequirements = [createPhases, false, true] as const
const changeRequirements = [changePhases, true, true] as const

const actionRequirements = (action: AuthorizationAction) => pipe(
  Match.value(action),
  Match.whenOr("read", "remove", Function.constant(readRequirements)),
  Match.when("create", Function.constant(createRequirements)),
  Match.whenOr("update", "patch", "transition", Function.constant(changeRequirements)),
  Match.exhaustive,
)

const RegisteredAuthorization = Symbol("RegisteredAuthorization")

class Registration extends Data.Class<{
  readonly runtime: AuthorizationRuntime
  readonly fields: PolicyFields
}> {}

type RegisteredPolicy = PolicyAuthorization & Readonly<Record<typeof RegisteredAuthorization, (candidate: PolicyAuthorization) => Effect.Effect<Registration, AuthorizationDefinitionError>>>
const isRegisteredPolicy = (value: PolicyAuthorization): value is RegisteredPolicy => Predicate.hasProperty(value, RegisteredAuthorization)

const makeScopeCheck = (scope: ReturnType<typeof Policy.evaluate>) =>
  Effect.fn("Authorization.scope")(function* (
    subject: Readonly<Record<string, unknown>>,
    row: Option.Option<Readonly<Record<string, unknown>>>,
    next: Option.Option<Readonly<Record<string, unknown>>>,
  ) {
    if (Option.isNone(row)) return
    const environment = new PolicyEnvironment({ subject, row, next })
    const allowed = yield* scope(environment)
    if (!allowed) return yield* forbidden()
  })

const makeSubject = (
  subjectSchema: StructSchema,
  rules: Readonly<Record<string, ReturnType<typeof Policy.evaluate>>>,
  policies: Readonly<Record<string, PolicySyntax>>,
  requirements: EntitlementRequirements,
) => {
  const isSubject = Schema.is(subjectSchema)
  const subjectRequirements = (entries: EntitlementMap[string]) => Array.filter(entries ?? emptyEntitlements, subjectEntitlement)
  const preflight = Record.map(requirements as EntitlementMap, subjectRequirements)
  const subjectReference = (reference: Exclude<Operand, { readonly _tag: "Literal" }>) => Predicate.isTagged(reference, "SubjectField")
  const subjectOnly = flow(Policy.references, Array.every(subjectReference))
  const subjectRules = Record.filter(rules, (_, action) => subjectOnly(policies[action] as PolicySyntax))
  const unrestricted = Policy.evaluate(truePolicy)

  return Effect.fn("Authorization.subject")(function* (action: AuthorizationAction) {
    if (!Record.has(rules, action)) return yield* forbidden()
    const supplied = yield* Effect.serviceOption(AuthorizationSubject)
    const claims = Option.filter(supplied, isSubject)
    const subject = yield* pipe(claims, Effect.fromOption, Effect.mapError(Function.constant(unauthenticatedError)))
    const required = requirementsFor(preflight, action)
    if (Array.isReadonlyArrayEmpty(required)) return subject
    const environment = new PolicyEnvironment({ subject, row: absentPolicyRow, next: absentPolicyRow })
    const evaluate = subjectRules[action] ?? unrestricted
    const allowed = yield* pipe(evaluate(environment), Effect.catchTag("PolicyEvaluationError", forbidden))
    if (!allowed) return yield* forbidden()
    yield* pipe(checkEntitlements(required, environment), Effect.catchTag("PolicyEvaluationError", forbidden))
    return subject
  })
}

const makeCheck = (rules: Readonly<Record<string, ReturnType<typeof Policy.evaluate>>>, scopeCheck: ReturnType<typeof makeScopeCheck>, requirements: EntitlementRequirements) =>
  Effect.fn("Authorization.check")(function* (action: AuthorizationAction, subject: Readonly<Record<string, unknown>>, values: AuthorizationValues) {
    const [, current, candidate] = actionRequirements(action)
    const missingCurrent = current && Option.isNone(values.row)
    const missingCandidate = candidate && Option.isNone(values.next)
    const missingValue = missingCurrent || missingCandidate
    if (missingValue) return yield* forbidden()
    const evaluate = yield* pipe(Record.get(rules, action), Effect.fromOption, Effect.mapError(Function.constant(forbiddenError)))
    yield* scopeCheck(subject, values.row, values.next)
    yield* scopeCheck(subject, values.next, values.next)
    const environment = new PolicyEnvironment({ subject, ...values })
    const allowed = yield* evaluate(environment)
    if (!allowed) return yield* forbidden()
    const required = requirementsFor(requirements, action)
    if (!candidate) return yield* checkEntitlements(required, environment)
    const readable = yield* pipe(Record.get(rules, "read"), Effect.fromOption, Effect.mapError(Function.constant(forbiddenError)))
    const readEnvironment = new PolicyEnvironment({ subject, row: values.next, next: values.next })
    const visible = yield* readable(readEnvironment)
    if (!visible) return yield* forbidden()
    const readRequired = requirementsFor(requirements, "read")
    yield* checkEntitlements(required, environment)
    yield* checkEntitlements(readRequired, readEnvironment)
  })


const constructPolicy = <Resource extends StructSchema, Subject extends StructSchema>(
  resource: Resource,
  subject: Subject,
  definition: Readonly<{
    readonly scope: PolicyExpression<"row" | "subject"> | SubjectPolicy<Subject>
    readonly allow: Partial<Record<AuthorizationAction, PolicyExpression<PolicyPhase> | SubjectPolicy<Subject>>>
  }> & Readonly<Partial<{ require: EntitlementRequirements }>>,
): PolicyAuthorization<Resource, Subject> => {
  const normalization = normalizePolicyDefinition(subject, definition)
  const normalized = Effect.runSync(normalization)

  const source = Option.match(normalized.require, {
    onNone: () => PolicyAuthorizationSchema.make({ resource, subject, scope: normalized.scope, allow: normalized.allow }),
    onSome: (require) => PolicyAuthorizationSchema.make({ resource, subject, scope: normalized.scope, allow: normalized.allow, require }),
  })

  const resourceFields = describeFields(resource)
  const subjectFields = describeFields(subject)
  const fields = new PolicyFields({ resource: resourceFields, subject: subjectFields })

  const validateAction = (action: AuthorizationAction) => pipe(policyFor(source, action), Option.match({
    onNone: Function.constant(Effect.void),
    onSome: (policy) => {
      const [phases] = actionRequirements(action)
      return checkPolicy(policy, fields, phases, `allow.${action}`)
    },
  }))

  const validation = Effect.gen(function* () {
    yield* checkPolicy(source.scope, fields, scopePhases, "scope")
    yield* Effect.forEach(actions, validateAction, { discard: true })

    yield* Effect.forEach(actions, Effect.fn("Authorization.validateRequirements")(function* (action) {
      const required = requirementsFor(source.require ?? emptyEntitlementRequirements, action)
      const missingPolicy = pipe(policyFor(source, action), Option.isNone)
      const missingGrant = required.length > 0 && missingPolicy
      if (missingGrant) return yield* failure(`require.${action} needs an allow.${action} policy`)
      const [phases] = actionRequirements(action)
      yield* validateEntitlements(required, fields, phases)
    }), { discard: true })
  })

  Effect.runSync(validation)
  const mappedAllow = Record.map(source.allow as Readonly<Record<string, PolicySyntax>>, Policy.snapshot)
  const allow = Object.freeze(mappedAllow)
  const scope = Policy.snapshot(source.scope)
  const snapshotEntries = (entries: EntitlementMap[string]) => snapshotEntitlements(entries ?? emptyEntitlements)
  const required = pipe(source.require ?? emptyEntitlementRequirements, (requirements) => Record.map(requirements as EntitlementMap, snapshotEntries), Object.freeze)
  const descriptor = PolicyAuthorizationSchema.make({ resource, subject, scope, allow, require: required })
  const value = Struct.assign(descriptor, { resource, subject })
  const snapshot = Object.freeze(value)
  const rules = Record.map(allow, Policy.evaluate)
  const scopeCheck = pipe(scope, Policy.evaluate, makeScopeCheck)
  const readPolicy = pipe(policyFor(snapshot, "read"), Option.getOrElse(defaultReadPolicy))
  const visibility = Policy.all(scope, readPolicy)

  const runtime: AuthorizationRuntime = {
    visibility,
    subject: makeSubject(subject, rules, allow, required),
    check: makeCheck(rules, scopeCheck, required),
  }

  const compiled = pipe(new Registration({ runtime, fields }), Effect.succeed)

  const registration = (candidate: PolicyAuthorization) => equals(candidate, registered)
    ? compiled : failure("policy authorization registration does not match its definition")

  const registered = Struct.assign(snapshot, { [RegisteredAuthorization]: registration })
  return Object.freeze(registered)
}

const registeredPolicy = (authorization: PolicyAuthorization, resource: StructSchema) => {
  if (!isRegisteredPolicy(authorization)) return failure("policy authorization must be created with Authorization.for(...).policy(...)")

  return equals(authorization.resource, resource)
    ? authorization[RegisteredAuthorization](authorization)
    : failure("authorization resource schema must match the compiled resource schema")
}

const compiledPolicy = Effect.fn("Authorization.compiledPolicy")(function* (authorization: PolicyAuthorization, resource: StructSchema) {
  const registered = yield* registeredPolicy(authorization, resource)
  return registered.runtime
})

const subjectBindingCompatible = (destination: FieldIR, source: FieldIR) => {
  const category = sameFieldCategory(destination.category, source.category)
  const collection = equals(destination.collection, source.collection)
  const required = !source.nullable
  const nullable = destination.nullable || required
  const shape = category && collection
  return shape && nullable
}

const isSubjectOperand = (value: unknown): value is Extract<Operand, { readonly _tag: "SubjectField" }> =>
  Schema.is(OperandSchema)(value) && Predicate.isTagged(value, "SubjectField")

const validateSubjectBinding = Effect.fn("Authorization.validateSubjectBinding")(function* (fields: PolicyFields, target: string, binding: unknown) {
  if (!isSubjectOperand(binding)) return yield* failure(`create subject binding ${target} must reference a subject field`)
  const destination = fieldFor(fields.resource, target)
  const source = fieldFor(fields.subject, binding.field)

  const [destinationDescription, sourceDescription] = yield* pipe(
    Option.all([destination, source] as const),
    Effect.fromOption,
    Effect.mapError(() => definitionError(`create subject binding ${target} references unknown field`)),
  )

  if (!subjectBindingCompatible(destinationDescription, sourceDescription)) {
    return yield* failure(`create subject binding ${target} is incompatible with subject.${binding.field}`)
  }
})

const validateSubjectBindings = Effect.fn("Authorization.validateSubjectBindings")(function* (authorization: AuthorizationDefinition, resource: StructSchema, bindings: Readonly<Record<string, unknown>>) {
  if (Record.isEmptyRecord(bindings)) return
  if (!isPolicyAuthorization(authorization)) return yield* failure("create subject bindings require policy authorization")
  const registered = yield* registeredPolicy(authorization, resource)
  const entries = Record.toEntries(bindings)
  yield* Effect.forEach(entries, ([target, binding]) => validateSubjectBinding(registered.fields, target, binding), { discard: true })
})

const hasIdentityEncoding = (schema: Schema.Constraint) => pipe(
  Option.fromNullishOr(schema.ast.encoding),
  Option.match({
    onSome: Function.constFalse,
    onNone: () => pipe(Schema.toEncoded(schema), Struct.get("ast"), equals(schema.ast)),
  }),
)

const tableField = (table: Table, name: string) => Array.findFirst(table.fields, flow(Struct.get("name"), equals(name)))

const CompatibleSqlScalarSchema = Schema.Union([
  Schema.Tuple([Schema.Literal("string"), Schema.Literal("string")]),
  Schema.Tuple([Schema.Literal("number"), Schema.Literals(["integer", "number"])]),
  Schema.Tuple([Schema.Literal("boolean"), Schema.Literal("integer")]),
])

const isCompatibleSqlScalar = Schema.is(CompatibleSqlScalarSchema)

const storageCompatible = (description: FieldIR, field: Table["fields"][number]) => {
  const nullable = equals(description.nullable, field.nullable)
  const category = Option.getOrNull(description.category)
  return nullable && isCompatibleSqlScalar([category, field.scalar])
}

const validateSqlReference = (resource: StructSchema, storage: StructSchema, table: Table, fields: FieldDescriptions) =>
  Effect.fn("Authorization.validateSqlReference")(function* (reference: Operand) {
    if (!Predicate.isTagged(reference, "RowField")) return
    const canonical = Record.get(resource.fields, reference.field)
    const physical = Record.get(storage.fields, reference.field)
    const definition = tableField(table, reference.field)

    const [canonicalSchema, physicalSchema, field] = yield* pipe(
      Option.all([canonical, physical, definition] as const),
      Effect.fromOption,
      Effect.mapError(() => definitionError(`SQL policy references unknown row.${reference.field}`)),
    )

    const description = yield* pipe(
      fieldFor(fields, reference.field),
      Effect.fromOption,
      Effect.mapError(() => definitionError(`SQL policy references unknown row.${reference.field}`)),
    )

    const same = equals(canonicalSchema, physicalSchema)
    const identity = same && hasIdentityEncoding(canonicalSchema)
    if (!identity) return yield* failure(`SQL policy row.${reference.field} must use an identity storage encoding`)
    const scalar = !description.collection
    const compatible = scalar && storageCompatible(description, field)
    if (!compatible) return yield* failure(`SQL policy row.${reference.field} does not have a compatible physical scalar`)
  })

const validateSqlStorage = Effect.fn("Authorization.validateSqlStorage")(function* (resource: StructSchema, storage: StructSchema, table: Table, visibility: PolicySyntax, fields: FieldDescriptions) {
  if (!isStruct(storage)) return yield* failure("SQL policy storage schema must be a flat struct")
  const references = Policy.references(visibility)
  const validateReference = validateSqlReference(resource, storage, table, fields)
  yield* Effect.forEach(references, validateReference, { discard: true })
})

const publicSubjectEffect = Effect.succeed({})
const publicSubject = Function.constant(publicSubjectEffect)
const publicCheck = Function.constant(Effect.void)

const publicAccess: AuthorizationRuntime = {
  visibility: truePolicy,
  subject: publicSubject,
  check: publicCheck,
}

const denyAccess: AuthorizationRuntime = {
  visibility: falsePolicy,
  subject: forbidden,
  check: forbidden,
}

const publicAccessEffect = Effect.succeed(publicAccess)
const denyAccessEffect = Effect.succeed(denyAccess)
const compileStandalonePolicy = (policy: PolicyAuthorization) => compiledPolicy(policy, policy.resource)

const standalone = (authorization: AuthorizationDefinition) => pipe(
  Match.value(authorization),
  Match.when(isPublicAuthorization, Function.constant(publicAccessEffect)),
  Match.when(isDenyAuthorization, Function.constant(denyAccessEffect)),
  Match.when(isPolicyAuthorization, compileStandalonePolicy),
  Match.orElse(() => failure("authorization must be Public, Deny, or Policy")),
)

export const Authorization = {
  public: publicAuthorization,
  deny: denyAuthorization,
  for: policyDsl,
  subject: subjectPolicyDsl,
  requireSubject,
  validateSubjectBindings,
  compile: Effect.fn("Authorization.compile")(function* (options: Readonly<{ readonly authorization: AuthorizationDefinition; readonly resource: StructSchema; readonly storage: StructSchema; readonly table: Table }>) {
    if (!isPolicyAuthorization(options.authorization)) return yield* standalone(options.authorization)
    const registered = yield* registeredPolicy(options.authorization, options.resource)
    yield* validateSqlStorage(options.resource, options.storage, options.table, registered.runtime.visibility, registered.fields.resource)
    return registered.runtime
  }),
  require: Effect.fn("Authorization.require")(function* (authorization: AuthorizationDefinition, action: AuthorizationAction, values: AuthorizationValues) {
    const compiled = yield* standalone(authorization)
    const subject = yield* compiled.subject(action)
    yield* compiled.check(action, subject, values)
  }),
}
