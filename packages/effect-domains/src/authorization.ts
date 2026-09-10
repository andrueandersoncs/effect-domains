import { Array, Context, Data, Effect, Equivalence, Function, HashSet, Match, Option, Predicate, Record, Schema, SchemaAST, Struct, Tuple, flow, pipe } from "effect"
import { type StructSchema } from "./domain.ts"
import { OperandSchema, Policy, PolicyEnvironment, type Operand, type Policy as PolicySyntax, type PolicyF, PolicyEvaluationError, type Scalar } from "./policy.ts"
import type { Table } from "./table.ts"
import { ScalarSchema, ownValue, scalarChecks, type ScalarF } from "./schema-algebra.ts"

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

export type AuthorizationAction = keyof typeof PolicyRulesSchema.fields

const isStruct = (value: unknown): value is StructSchema => Schema.isSchema(value) && SchemaAST.isObjects(value.ast)

const PublicAuthorizationSchema = Schema.TaggedStruct("Public", {})
const DenyAuthorizationSchema = Schema.TaggedStruct("Deny", {})
type ScalarCategory = "string" | "number" | "boolean"

class FieldDescription extends Data.Class<{
  readonly category: Option.Option<ScalarCategory>
  readonly nullable: boolean
  readonly collection: boolean
}> {}

type FieldDescriptions = Readonly<Record<string, Option.Option<FieldDescription>>>

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
  remove: OptionalPolicySchema,
}).annotate({ parseOptions: { onExcessProperty: "error" } })

interface PolicyRules extends Schema.Schema.Type<typeof PolicyRulesSchema> {}

const PolicyAuthorizationSchema = Schema.TaggedStruct("Policy", {
  resource: StructValueSchema,
  subject: StructValueSchema,
  scope: Policy.Schema,
  allow: PolicyRulesSchema,
})

export interface PolicyAuthorization<Resource extends StructSchema = StructSchema, Subject extends StructSchema = StructSchema> extends Schema.Schema.Type<typeof PolicyAuthorizationSchema> {
  readonly resource: Resource
  readonly subject: Subject
}

export interface SubjectPolicy<Subject extends StructSchema = StructSchema> {
  readonly subject: Subject
  readonly expression: PolicyExpression<"subject">
}

export type AuthorizationDefinition = Schema.Schema.Type<typeof PublicAuthorizationSchema> | Schema.Schema.Type<typeof DenyAuthorizationSchema> | PolicyAuthorization

export interface AuthorizationRuntime {
  readonly visibility: PolicySyntax
  readonly subject: (action: AuthorizationAction) => Effect.Effect<Readonly<Record<string, unknown>>, Unauthenticated | Forbidden>
  readonly check: (action: AuthorizationAction, subject: Readonly<Record<string, unknown>>, values: AuthorizationValues) => Effect.Effect<void, Forbidden | PolicyEvaluationError>
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

const membership = <Collection extends ScalarCollection, Value extends ScalarOperand>(collection: Collection, value: Value & Comparable<CollectionValue<Collection>, OperandValue<Value>>) => pipe(
  Policy.Schema.make({ _tag: "Includes", collection: collectionOperand(collection), value: operand(value) }),
  expression<OperandPhases<Collection> | OperandPhases<Value>>,
)

const all = <const Expressions extends ReadonlyArray<PolicyExpression>>(...children: Expressions) =>
  pipe(Policy.all(...children), expression<ExpressionPhase<Expressions[number]>>)

const any = <const Expressions extends ReadonlyArray<PolicyExpression>>(...children: Expressions) =>
  pipe(Policy.any(...children), expression<ExpressionPhase<Expressions[number]>>)

const policyDsl = <Resource extends StructSchema, Subject extends StructSchema>(schemas: Readonly<{ readonly resource: Resource; readonly subject: Subject }>) => {
  const subject = policyFields<Subject, "SubjectField", "subject">(schemas.subject, "SubjectField")
  const row = policyFields<Resource, "RowField", "row">(schemas.resource, "RowField")
  const next = policyFields<Resource, "NextField", "next">(schemas.resource, "NextField")
  const unchangedField = (field: ScalarOnlyFieldName<Resource>) => Policy.Schema.make({ _tag: "Equal", left: row[field] as Operand, right: next[field] as Operand })

  const unchanged = (...fields: ReadonlyArray<ScalarOnlyFieldName<Resource>>) => {
    const comparisons = Array.map(fields, unchangedField)
    return pipe(Policy.all(...comparisons), expression<"row" | "next">)
  }

  const policy = <Allow extends Partial<{
    readonly read: PolicyExpression<"row" | "subject">
    readonly create: PolicyExpression<"next" | "subject">
    readonly update: PolicyExpression<"row" | "next" | "subject">
    readonly patch: PolicyExpression<"row" | "next" | "subject">
    readonly remove: PolicyExpression<"row" | "subject">
  }>>(definition: Readonly<{ readonly scope: PolicyExpression<"row" | "subject">; readonly allow: Allow }>) => constructPolicy(schemas.resource, schemas.subject, definition)

  return { subject, row, next, eq, includes: membership, all, any, unchanged, policy, literal: literalOperand }
}

const subjectPolicyDsl = <Subject extends StructSchema>(subject: Subject) => {
  const policy = (condition: PolicyExpression<"subject">) => constructSubjectPolicy(subject, condition)
  return { subject: policyFields<Subject, "SubjectField", "subject">(subject, "SubjectField"), eq, includes: membership, all, any, literal: literalOperand, policy }
}

const finiteNumber = (ast: SchemaAST.Number) => pipe(scalarChecks(ast), Array.some((check) => {
  const id = ownValue(check.annotations?.representation, "id")
  return equals(id, "effect/schema/isFinite") || equals(id, "effect/schema/isInt")
}))

const describe = (category: Option.Option<ScalarCategory>, nullable = false, collection = false) =>
  new FieldDescription({ category, nullable, collection })

const emptyCategory = Option.none<ScalarCategory>()
const neutralDescription = describe(emptyCategory)
const nullDescription = describe(emptyCategory, true)
const optionalNull = Option.some(nullDescription)
const optionalString = pipe(Option.some<ScalarCategory>("string"), describe, Option.some)
const optionalNumber = pipe(Option.some<ScalarCategory>("number"), describe, Option.some)
const optionalBoolean = pipe(Option.some<ScalarCategory>("boolean"), describe, Option.some)

const scalarLiteral = (value: unknown) => pipe(
  Match.value(value),
  Match.when(Predicate.isNull, Function.constant(optionalNull)),
  Match.when(Predicate.isString, Function.constant(optionalString)),
  Match.when(Predicate.isBoolean, Function.constant(optionalBoolean)),
  Match.when(Schema.is(Schema.Finite), Function.constant(optionalNumber)),
  Match.orElse(Option.none<FieldDescription>),
)

const asCollection = (description: FieldDescription) => new FieldDescription({ ...description, collection: true })

const scalarAlgebra = (layer: ScalarF<Option.Option<FieldDescription>>): Option.Option<FieldDescription> => {
  const classifyNumber = (number: SchemaAST.Number) => finiteNumber(number) ? optionalNumber : Option.none<FieldDescription>()

  const leaf = (ast: SchemaAST.AST) => pipe(
    Match.value(ast),
    Match.tag("String", "TemplateLiteral", Function.constant(optionalString)),
    Match.tag("Number", classifyNumber),
    Match.tag("Boolean", Function.constant(optionalBoolean)),
    Match.tag("Null", Function.constant(optionalNull)),
    Match.tag("Literal", flow(Struct.get<SchemaAST.Literal, "literal">("literal"), scalarLiteral)),
    Match.tag("Enum", flow(Struct.get<SchemaAST.Enum, "enums">("enums"), Array.map(flow(Tuple.get<readonly [string, string | number], 1>(1), scalarLiteral)), combineDescriptions)),
    Match.orElse(Option.none<FieldDescription>),
  )

  return pipe(Match.value(layer), Match.tagsExhaustive({
    Leaf: ({ ast }) => leaf(ast),
    Unsupported: Option.none<FieldDescription>,
    Encoding: Option.none<FieldDescription>,
    Suspend: ({ value }) => value,
    Union: ({ members }) => combineDescriptions(members),
    Collection: ({ value }) => pipe(value, Option.filter(Predicate.not(Struct.get("collection"))), Option.map(asCollection)),
  }))
}

const scalarDescription = ScalarSchema.fold("canonical", scalarAlgebra)

const combineDescriptions = (descriptions: ReadonlyArray<Option.Option<FieldDescription>>) => {
  const merge = (left: FieldDescription, right: FieldDescription) => {
    const scalar = !right.collection
    const compatible = sameCategory(left.category, right.category)
    const valid = scalar && compatible
    if (!valid) return Option.none<FieldDescription>()
    const category = Option.orElse(left.category, Function.constant(right.category))
    const nullable = left.nullable || right.nullable
    return pipe(describe(category, nullable), Option.some)
  }

  const reduce = (state: Option.Option<FieldDescription>, next: Option.Option<FieldDescription>) => pipe(
    Option.all([state, next] as const),
    Option.flatMap(Function.tupled(merge)),
  )

  const initial = Option.some(neutralDescription)
  return Array.reduce(descriptions, initial, reduce)
}

const fieldDescription = (schema: Schema.Constraint) => {
  const ast = SchemaAST.toType(schema.ast)
  return SchemaAST.isOptional(ast) ? Option.none() : scalarDescription(ast)
}

const literalDescription = (value: Scalar | ReadonlyArray<Scalar>) => Array.isArray(value)
  ? pipe(value, Array.map(scalarLiteral), combineDescriptions, Option.map(asCollection))
  : scalarLiteral(value)

const describeFields = (schema: StructSchema): FieldDescriptions => Record.map(schema.fields, fieldDescription)
const fieldFor = (fields: FieldDescriptions, field: string) => pipe(Record.get(fields, field), Option.flatten)

const sameCategory = (left: Option.Option<ScalarCategory>, right: Option.Option<ScalarCategory>) => {
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
  Match.tag("Literal", flow(Struct.get<Extract<Operand, { readonly _tag: "Literal" }>, "value">("value"), literalDescription, Option.match({
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
  if (!sameCategory(leftDescription.category, rightDescription.category)) return yield* failure(`${label} ${inclusion ? "includes" : "equality"} operands must have the same scalar type`)
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

const RegisteredSubjectPolicy = Symbol("RegisteredSubjectPolicy")

type RegisteredSubjectPolicy<Subject extends StructSchema> = SubjectPolicy<Subject> & Readonly<Record<
  typeof RegisteredSubjectPolicy,
  (candidate: SubjectPolicy<Subject>) => Effect.Effect<Subject["Type"], Forbidden, AuthorizationSubject>
>>

const isRegisteredSubjectPolicy = <Subject extends StructSchema>(policy: SubjectPolicy<Subject>): policy is RegisteredSubjectPolicy<Subject> =>
  Predicate.hasProperty(policy, RegisteredSubjectPolicy)

const subjectPhases = HashSet.fromIterable<PolicyPhase>(["subject"])
const absentPolicyRow = Option.none<Readonly<Record<string, unknown>>>()

const constructSubjectPolicy = <Subject extends StructSchema>(subject: Subject, condition: PolicyExpression<"subject">): SubjectPolicy<Subject> => {
  const subjectFields = describeFields(subject)
  const fields = new PolicyFields({ resource: {}, subject: subjectFields })
  pipe(checkPolicy(condition, fields, subjectPhases, "subject policy"), Effect.runSync)
  const snapshot = pipe(condition, Policy.snapshot, expression<"subject">)
  const evaluate = Policy.evaluate(snapshot)
  const isSubject = Schema.is(subject)

  const require = Effect.gen(function* () {
    const claims = yield* AuthorizationSubject
    if (!isSubject(claims)) return yield* forbidden()
    const environment = new PolicyEnvironment({ subject: claims, row: absentPolicyRow, next: absentPolicyRow })
    const allowed = yield* pipe(evaluate(environment), Effect.catchTag("PolicyEvaluationError", forbidden))
    if (!allowed) return yield* forbidden()
    return claims
  })

  const invalidRegistration = pipe(definitionError("subject policy registration does not match its definition"), Effect.die)
  const registration = (candidate: SubjectPolicy<Subject>) => equals(candidate, registered) ? require : invalidRegistration
  const registered = Object.freeze({ subject, expression: snapshot, [RegisteredSubjectPolicy]: registration })
  return registered
}

const requireSubject = <Subject extends StructSchema>(policy: SubjectPolicy<Subject>) =>
  isRegisteredSubjectPolicy(policy)
    ? policy[RegisteredSubjectPolicy](policy)
    : pipe(definitionError("subject policy must be constructed by Authorization.subject"), Effect.die)

const policyFor = (authorization: PolicyAuthorization, action: AuthorizationAction) => Option.fromNullishOr(authorization.allow[action])

const readRequirements = [scopePhases, true, false] as const
const createRequirements = [createPhases, false, true] as const
const changeRequirements = [changePhases, true, true] as const

const actionRequirements = (action: AuthorizationAction) => pipe(
  Match.value(action),
  Match.whenOr("read", "remove", Function.constant(readRequirements)),
  Match.when("create", Function.constant(createRequirements)),
  Match.whenOr("update", "patch", Function.constant(changeRequirements)),
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

const makeSubject = (subjectSchema: StructSchema, rules: Readonly<Record<string, ReturnType<typeof Policy.evaluate>>>) => {
  const isSubject = Schema.is(subjectSchema)

  return Effect.fn("Authorization.subject")(function* (action: AuthorizationAction) {
    if (!Record.has(rules, action)) return yield* forbidden()
    const supplied = yield* Effect.serviceOption(AuthorizationSubject)
    const claims = Option.filter(supplied, isSubject)
    if (Option.isNone(claims)) return yield* unauthenticated()
    return claims.value
  })
}

const makeCheck = (rules: Readonly<Record<string, ReturnType<typeof Policy.evaluate>>>, scopeCheck: ReturnType<typeof makeScopeCheck>) =>
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
    if (!candidate) return
    const readable = yield* pipe(Record.get(rules, "read"), Effect.fromOption, Effect.mapError(Function.constant(forbiddenError)))
    const readEnvironment = new PolicyEnvironment({ subject, row: values.next, next: values.next })
    const visible = yield* readable(readEnvironment)
    if (!visible) return yield* forbidden()
  })


const constructPolicy = <Resource extends StructSchema, Subject extends StructSchema>(resource: Resource, subject: Subject, definition: Readonly<{ readonly scope: PolicySyntax; readonly allow: Partial<Record<AuthorizationAction, PolicySyntax>> }>): PolicyAuthorization<Resource, Subject> => {
  const source = PolicyAuthorizationSchema.make({ resource, subject, ...definition })
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
  })

  Effect.runSync(validation)
  const mappedAllow = Record.map(source.allow as Readonly<Record<string, PolicySyntax>>, Policy.snapshot)
  const allow = Object.freeze(mappedAllow)
  const scope = Policy.snapshot(source.scope)
  const descriptor = PolicyAuthorizationSchema.make({ resource, subject, scope, allow })
  const value = Struct.assign(descriptor, { resource, subject })
  const snapshot = Object.freeze(value)
  const rules = Record.map(allow, Policy.evaluate)
  const scopeCheck = pipe(scope, Policy.evaluate, makeScopeCheck)
  const readPolicy = pipe(policyFor(snapshot, "read"), Option.getOrElse(defaultReadPolicy))
  const visibility = Policy.all(scope, readPolicy)

  const runtime: AuthorizationRuntime = {
    visibility,
    subject: makeSubject(subject, rules),
    check: makeCheck(rules, scopeCheck),
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

const subjectBindingCompatible = (destination: FieldDescription, source: FieldDescription) => {
  const category = sameCategory(destination.category, source.category)
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

const storageCompatible = (description: FieldDescription, field: Table["fields"][number]) => {
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
