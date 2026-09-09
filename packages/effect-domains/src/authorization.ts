import { Array, Context, Effect, Equivalence, Function, HashSet, Match, Option, Predicate, Record, Schema, SchemaAST, Struct, pipe } from "effect"
import { OperandSchema, Policy, type PolicyEnvironment, type Operand, type Policy as PolicySyntax, type PolicyF, PolicyEvaluationError, type Scalar } from "./policy.ts"
import type { Table } from "./table.ts"

export class AuthorizationSubject extends Context.Service<AuthorizationSubject, Readonly<Record<string, unknown>>>()("@effect-domains/AuthorizationSubject") {}
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()("Unauthenticated", {}) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}) {}
class AuthorizationDefinitionError extends Schema.TaggedError<AuthorizationDefinitionError>()("AuthorizationDefinitionError", { reason: Schema.String }) {}
export type AuthorizationAction = "read" | "create" | "update" | "patch" | "remove"
type AnyStruct = Schema.Struct<Schema.Struct.Fields>
type FieldName<S extends AnyStruct> = Extract<keyof S["fields"], string>
type FieldValue<S extends AnyStruct, Key extends FieldName<S>> = S["Type"][Key]

type ScalarOnlyFieldName<S extends AnyStruct> = {
  readonly [Key in FieldName<S>]: FieldValue<S, Key> extends Scalar ? Key : never
}[FieldName<S>]

type PolicyPhase = "subject" | "row" | "next"
declare const PolicyPhases: unique symbol
type PolicyExpression<Phases extends PolicyPhase = PolicyPhase> = PolicySyntax & Readonly<Record<typeof PolicyPhases, readonly [never, Phases]>>
type TypedOperand<Value, Phases extends PolicyPhase> = Operand & Readonly<Record<typeof PolicyPhases, readonly [Value, Phases]>>
export type SubjectOperand<Value> = TypedOperand<Value, "subject"> & Readonly<{ readonly _tag: "SubjectField" }>


type FieldReferences<S extends AnyStruct, Tag extends Operand["_tag"], Phases extends PolicyPhase> = {
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
const PublicAuthorizationSchema = Schema.TaggedStruct("Public", {})

const DenyAuthorizationSchema = Schema.TaggedStruct("Deny", {})
const isPublicAuthorization = Schema.is(PublicAuthorizationSchema)
const isDenyAuthorization = Schema.is(DenyAuthorizationSchema)
export type PublicAuthorization = Schema.Schema.Type<typeof PublicAuthorizationSchema>

type DenyAuthorization = Schema.Schema.Type<typeof DenyAuthorizationSchema>

export type PolicyAuthorization<Resource extends AnyStruct = AnyStruct, Subject extends AnyStruct = AnyStruct> = Readonly<{
  readonly _tag: "Policy"
  readonly resource: Resource
  readonly subject: Subject
  readonly scope: PolicySyntax
  readonly allow: Partial<Record<AuthorizationAction, PolicySyntax>>
}>

export type AuthorizationDefinition = PublicAuthorization | DenyAuthorization | PolicyAuthorization
export type AuthorizationValues = Readonly<Pick<PolicyEnvironment, "row" | "next">>

interface CompiledAuthorization {
  readonly visibility: PolicySyntax
  readonly subject: (action: AuthorizationAction) => Effect.Effect<Readonly<Record<string, unknown>>, Unauthenticated | Forbidden>
  readonly check: (action: AuthorizationAction, subject: Readonly<Record<string, unknown>>, values: AuthorizationValues) => Effect.Effect<void, Forbidden | PolicyEvaluationError>
}

type ScalarCategory = "string" | "number" | "boolean"

type FieldDescription = Readonly<{
  readonly category: Option.Option<ScalarCategory>
  readonly nullable: boolean
  readonly collection: boolean
}>

const publicAuthorization = PublicAuthorizationSchema.make({})
const denyAuthorization = DenyAuthorizationSchema.make({})
const truePolicy = Policy.constant(true)
const falsePolicy = Policy.constant(false)
const policyFailure = (input: ConstructorParameters<typeof AuthorizationDefinitionError>[0]) => pipe(AuthorizationDefinitionError.make(input), Effect.fail)
const forbiddenEffect = pipe(Forbidden.make({}), Effect.fail)
const unauthenticatedEffect = pipe(Unauthenticated.make({}), Effect.fail)
const forbidden = Function.constant(forbiddenEffect)
const unauthenticated = Function.constant(unauthenticatedEffect)
const isTaggedOperand = (value: unknown): value is Operand => Predicate.hasProperty(value, "_tag")
const isPolicyAuthorization = (value: unknown): value is PolicyAuthorization => Predicate.isTagged(value, "Policy")
const literalOperand = <Value extends Scalar | ReadonlyArray<Scalar>>(value: Value) => OperandSchema.make({ _tag: "Literal", value }) as TypedOperand<Value, never>
const operand = <Value extends Scalar>(value: TypedOperand<Value, PolicyPhase> | Value) => (isTaggedOperand(value) ? (value as TypedOperand<Value, PolicyPhase>) : (literalOperand(value) as TypedOperand<Value, PolicyPhase>))
const collectionOperand = <Value extends Scalar>(value: TypedOperand<ReadonlyArray<Value>, PolicyPhase> | ReadonlyArray<Value>) => (isTaggedOperand(value) ? (value as TypedOperand<ReadonlyArray<Value>, PolicyPhase>) : (literalOperand(value) as TypedOperand<ReadonlyArray<Value>, PolicyPhase>))
const expression = <Phases extends PolicyPhase>(policy: PolicySyntax) => policy as PolicyExpression<Phases>
const policyField = <Value, Tag extends "SubjectField" | "RowField" | "NextField", Phases extends PolicyPhase>(tag: Tag, field: string) => OperandSchema.make({ _tag: tag, field }) as TypedOperand<Value, Phases> & Readonly<{ readonly _tag: Tag }>

const policyFields = <S extends AnyStruct, Tag extends "SubjectField" | "RowField" | "NextField", Phases extends PolicyPhase>(schema: S, tag: Tag) => {
  const fields = Struct.keys(schema.fields)

  const fieldEntry = (field: string) => {
    const reference = policyField(tag, field)
    return [field, reference] as const
  }

  const entries = Array.map(fields, fieldEntry)
  return Record.fromEntries(entries) as FieldReferences<S, Tag, Phases>
}

const policyDsl = <Resource extends AnyStruct, Subject extends AnyStruct>(
  schemas: Readonly<{
    readonly resource: Resource
    readonly subject: Subject
  }>,
) => {
  const subject = policyFields<Subject, "SubjectField", "subject">(schemas.subject, "SubjectField")
  const row = policyFields<Resource, "RowField", "row">(schemas.resource, "RowField")
  const next = policyFields<Resource, "NextField", "next">(schemas.resource, "NextField")

  const eq = <Left extends ScalarOperand, Right extends ScalarOperand>(left: Left, right: Right & Comparable<OperandValue<Left>, OperandValue<Right>>) => {
    const leftOperand = operand(left)
    const rightOperand = operand(right)
    const policy = Policy.Schema.make({ _tag: "Equal", left: leftOperand, right: rightOperand })
    return expression<OperandPhases<Left> | OperandPhases<Right>>(policy)
  }

  const membership = <Collection extends ScalarCollection, Value extends ScalarOperand>(collection: Collection, value: Value & Comparable<CollectionValue<Collection>, OperandValue<Value>>) => {
    const collectionValue = collectionOperand(collection)
    const operandValue = operand(value)
    const policy = Policy.Schema.make({ _tag: "Includes", collection: collectionValue, value: operandValue })
    return expression<OperandPhases<Collection> | OperandPhases<Value>>(policy)
  }

  const all = <const Expressions extends ReadonlyArray<PolicyExpression>>(...children: Expressions) => pipe(Policy.all(...children), expression<ExpressionPhase<Expressions[number]>>)
  const any = <const Expressions extends ReadonlyArray<PolicyExpression>>(...children: Expressions) => pipe(Policy.any(...children), expression<ExpressionPhase<Expressions[number]>>)

  const unchanged = (...fields: ReadonlyArray<ScalarOnlyFieldName<Resource>>) => {
    const equality = (field: ScalarOnlyFieldName<Resource>): PolicySyntax => {
      const current = row[field] as Operand
      const candidate = next[field] as Operand
      return Policy.Schema.make({ _tag: "Equal", left: current, right: candidate })
    }

    const checks = Array.map(fields, equality)
    const policy = Policy.all(...checks)
    return expression<"row" | "next">(policy)
  }

  const policy = <
    Allow extends Partial<{
      readonly read: PolicyExpression<"row" | "subject">
      readonly create: PolicyExpression<"next" | "subject">
      readonly update: PolicyExpression<"row" | "next" | "subject">
      readonly patch: PolicyExpression<"row" | "next" | "subject">
      readonly remove: PolicyExpression<"row" | "subject">
    }>,
  >(
    definition: Readonly<{
      readonly scope: PolicyExpression<"row" | "subject">
      readonly allow: Allow
    }>,
  ): PolicyAuthorization<Resource, Subject> => {
    return constructPolicy(schemas.resource, schemas.subject, definition)
  }

  return { subject, row, next, eq, includes: membership, all, any, unchanged, policy, literal: literalOperand }
}

const checkId = (check: SchemaAST.Check<unknown>, id: string): boolean => {
  const representation = Option.fromNullishOr(check.annotations?.representation?.id)
  const matches = Option.exists(representation, (value) => value === id)

  const nested = pipe(
    Match.value(check),
    Match.when({ _tag: "FilterGroup" }, ({ checks }) => Array.some(checks, (child) => checkId(child, id))),
    Match.orElse(Function.constant(false)),
  )

  return matches || nested
}

const finiteNumber = (ast: SchemaAST.Number) => {
  const checks = Option.fromNullishOr(ast.checks)
  const checked = Option.getOrElse(checks, Function.constant([]))
  const finite = Array.some(checked, (check) => checkId(check, "effect/schema/isFinite"))
  const integer = Array.some(checked, (check) => checkId(check, "effect/schema/isInt"))
  return finite || integer
}

const unknownCategory = Option.none<ScalarCategory>()
const stringCategory = Option.some<ScalarCategory>("string")
const numberCategory = Option.some<ScalarCategory>("number")
const booleanCategory = Option.some<ScalarCategory>("boolean")

const description = (category: Option.Option<ScalarCategory>, nullable: boolean, collection: boolean): FieldDescription => ({
  category,
  nullable,
  collection,
})

const scalarField = (category: Option.Option<ScalarCategory>, nullable = false) => pipe(description(category, nullable, false), Option.some)
const isFiniteNumber = Schema.is(Schema.Finite)
const stringField = scalarField(stringCategory)
const numberField = scalarField(numberCategory)
const booleanField = scalarField(booleanCategory)
const nullField = scalarField(unknownCategory, true)
const noFieldDescription = pipe(Option.none<FieldDescription>(), Function.constant)
const emptySuspensions = HashSet.empty<SchemaAST.Suspend>()
const asCollection = (field: FieldDescription) => description(field.category, field.nullable, true)
const isScalarField = (field: FieldDescription) => !field.collection
const scalarLiteralDescription = (value: unknown) => pipe(Match.value(value), Match.when(Predicate.isNull, Function.constant(nullField)), Match.when(Predicate.isString, Function.constant(stringField)), Match.when(Predicate.isBoolean, Function.constant(booleanField)), Match.when(isFiniteNumber, Function.constant(numberField)), Match.orElse(noFieldDescription))
const scalarDescriptionFor = (seen: HashSet.HashSet<SchemaAST.Suspend>) => (ast: SchemaAST.AST) => scalarDescription(ast, seen)

const scalarArrayDescription = (ast: SchemaAST.Arrays, seen: HashSet.HashSet<SchemaAST.Suspend>) => {
  const noElements = Array.isReadonlyArrayEmpty(ast.elements)
  if (!noElements) return Option.none()
  const oneRest = ast.rest.length === 1
  if (!oneRest) return Option.none()
  return pipe(Array.head(ast.rest), Option.flatMap(scalarDescriptionFor(seen)), Option.filter(isScalarField), Option.map(asCollection))
}

const enumMemberDescription = ([, value]: SchemaAST.Enum["enums"][number]) => scalarLiteralDescription(value)
const enumDescription = (ast: SchemaAST.Enum) => pipe(ast.enums, Array.map(enumMemberDescription), combineDescriptions)
const numberDescription = (ast: SchemaAST.Number) => (finiteNumber(ast) ? numberField : noFieldDescription())

const scalarDescription: (ast: SchemaAST.AST, seen: HashSet.HashSet<SchemaAST.Suspend>) => Option.Option<FieldDescription> = (ast, seen) =>
  pipe(
    Match.value(ast),
    Match.when(SchemaAST.isSuspend, (suspended) => {
      const recursive = HashSet.has(seen, suspended)
      if (recursive) return Option.none()
      const expanded = suspended.thunk()
      const expandedSeen = HashSet.add(seen, suspended)
      return scalarDescription(expanded, expandedSeen)
    }),
    Match.when(SchemaAST.isString, Function.constant(stringField)),
    Match.when(SchemaAST.isTemplateLiteral, Function.constant(stringField)),
    Match.when(SchemaAST.isNumber, numberDescription),
    Match.when(SchemaAST.isBoolean, Function.constant(booleanField)),
    Match.when(SchemaAST.isNull, Function.constant(nullField)),
    Match.when(SchemaAST.isLiteral, ({ literal }) => scalarLiteralDescription(literal)),
    Match.when(SchemaAST.isEnum, enumDescription),
    Match.when(SchemaAST.isUnion, ({ types }) => pipe(types, Array.map(scalarDescriptionFor(seen)), combineDescriptions)),
    Match.when(SchemaAST.isArrays, (array) => scalarArrayDescription(array, seen)),
    Match.orElse(noFieldDescription),
  )

const sameCategory = (left: Option.Option<ScalarCategory>, right: Option.Option<ScalarCategory>) =>
  Option.match(left, {
    onNone: Function.constant(true),
    onSome: (leftCategory) =>
      Option.match(right, {
        onNone: Function.constant(true),
        onSome: (rightCategory) => leftCategory === rightCategory,
      }),
  })

const combineDescriptions = (descriptions: ReadonlyArray<Option.Option<FieldDescription>>): Option.Option<FieldDescription> => {
  const complete = Array.every(descriptions, Option.isSome)
  if (!complete) return Option.none()

  const values = Array.getSomes(descriptions)
  const scalarValues = Array.every(values, isScalarField)
  if (!scalarValues) return Option.none()

  const categoryOptions = Array.map(values, Struct.get("category"))
  const categories = Array.getSomes(categoryOptions)
  const nullable = Array.some(values, Struct.get("nullable"))
  const first = Array.head(categories)
  return pipe(
    first,
    Option.match({
      onNone: () => scalarField(unknownCategory, nullable),
      onSome: (category) => {
        const homogeneous = Array.every(categories, (value) => category === value)
        if (!homogeneous) return Option.none()
        const categoryOption = Option.some(category)
        const combined = description(categoryOption, nullable, false)
        return Option.some(combined)
      },
    }),
  )
}

const fieldDescription = (schema: Schema.Constraint) => {
  const ast = SchemaAST.toType(schema.ast)
  return SchemaAST.isOptional(ast) ? Option.none() : scalarDescription(ast, emptySuspensions)
}

const literalDescription = (value: Scalar | ReadonlyArray<Scalar>): Option.Option<FieldDescription> =>
  pipe(
    Match.value(value),
    Match.when(Array.isArray, (entries) => {
      const descriptions = Array.map(entries, literalDescription)
      const combined = combineDescriptions(descriptions)
      const empty = Array.isReadonlyArrayEmpty(entries)
      if (empty) {
        const scalar = description(unknownCategory, false, true)
        return Option.some(scalar)
      }
      return pipe(combined, Option.map(asCollection))
    }),
    Match.orElse(scalarLiteralDescription),
  )

const fieldFor = (schema: AnyStruct, field: string) => pipe(Option.fromNullishOr(schema.fields[field]), Option.flatMap(fieldDescription))

const fieldOperandDescription = (allowed: HashSet.HashSet<PolicyPhase>, schema: AnyStruct, phase: PolicyPhase, field: string) => {
  const available = HashSet.has(allowed, phase)
  if (!available) return policyFailure({ reason: `${phase}.${field} is not available in this policy phase` })
  const description = fieldFor(schema, field)
  const error = `${phase}.${field} must be a known finite scalar or scalar collection field`
  return pipe(description, Option.match({ onNone: () => policyFailure({ reason: error }), onSome: Effect.succeed }))
}

const operandDescription = (operand: Operand, resource: AnyStruct, subject: AnyStruct, allowed: HashSet.HashSet<PolicyPhase>) =>
  pipe(
    Match.value(operand),
    Match.tagsExhaustive({
      Literal: ({ value }) =>
        pipe(
          literalDescription(value),
          Option.match({
            onNone: () => policyFailure({ reason: "policy literal must contain only finite scalar values" }),
            onSome: Effect.succeed,
          }),
        ),
      SubjectField: ({ field }) => fieldOperandDescription(allowed, subject, "subject", field),
      RowField: ({ field }) => fieldOperandDescription(allowed, resource, "row", field),
      NextField: ({ field }) => fieldOperandDescription(allowed, resource, "next", field),
    }),
  )

const checkEquality = Effect.fn("Authorization.checkEquality")(function* (left: Operand, right: Operand, resource: AnyStruct, subject: AnyStruct, allowed: HashSet.HashSet<PolicyPhase>, label: string) {
  const leftDescription = yield* operandDescription(left, resource, subject, allowed)
  const rightDescription = yield* operandDescription(right, resource, subject, allowed)
  const leftScalar = !leftDescription.collection
  if (!leftScalar) return yield* policyFailure({ reason: `${label} equality operands must be scalar` })
  const rightScalar = !rightDescription.collection
  if (!rightScalar) return yield* policyFailure({ reason: `${label} equality operands must be scalar` })
  const matching = sameCategory(leftDescription.category, rightDescription.category)
  if (!matching) return yield* policyFailure({ reason: `${label} equality operands must have the same scalar type` })
})

const checkInclusion = Effect.fn("Authorization.checkInclusion")(function* (collection: Operand, value: Operand, resource: AnyStruct, subject: AnyStruct, allowed: HashSet.HashSet<PolicyPhase>, label: string) {
  const collectionDescription = yield* operandDescription(collection, resource, subject, allowed)
  const valueDescription = yield* operandDescription(value, resource, subject, allowed)

  if (!collectionDescription.collection) return yield* policyFailure({ reason: `${label} includes requires a scalar collection and scalar value` })
  const scalarValue = !valueDescription.collection
  if (!scalarValue) return yield* policyFailure({ reason: `${label} includes requires a scalar collection and scalar value` })
  const matching = sameCategory(collectionDescription.category, valueDescription.category)
  if (!matching) return yield* policyFailure({ reason: `${label} includes operands must have the same scalar type` })
})

const policyLayerChecker = (resource: AnyStruct, subject: AnyStruct, allowed: HashSet.HashSet<PolicyPhase>, label: string) => (layer: PolicyF<Effect.Effect<void, AuthorizationDefinitionError>>) =>
  pipe(
    Match.value(layer),
    Match.tagsExhaustive({
      Constant: Function.constant(Effect.void),
      Equal: ({ left, right }) => checkEquality(left, right, resource, subject, allowed, label),
      Includes: ({ collection, value }) => checkInclusion(collection, value, resource, subject, allowed, label),
      All: ({ children }) => Effect.all(children, { discard: true }),
      Any: ({ children }) => Effect.all(children, { discard: true }),
    }),
  )

const checkPolicy = (policy: PolicySyntax, resource: AnyStruct, subject: AnyStruct, allowed: HashSet.HashSet<PolicyPhase>, label: string) => {
  const valid = Schema.is(Policy.Schema)(policy)
  if (!valid) return policyFailure({ reason: `${label} must be a valid policy syntax` })

  const layerChecker = policyLayerChecker(resource, subject, allowed, label)
  const checkLayer = Policy.fold(layerChecker)
  return checkLayer(policy)
}

const AuthorizationActions = ["read", "create", "update", "patch", "remove"] as const
const scopePhases = HashSet.fromIterable<PolicyPhase>(["row", "subject"])
const createPhases = HashSet.fromIterable<PolicyPhase>(["next", "subject"])
const changePhases = HashSet.fromIterable<PolicyPhase>(["row", "next", "subject"])
const actionPhases = (action: AuthorizationAction) => pipe(Match.value(action), Match.when("read", Function.constant(scopePhases)), Match.when("remove", Function.constant(scopePhases)), Match.when("create", Function.constant(createPhases)), Match.when("update", Function.constant(changePhases)), Match.when("patch", Function.constant(changePhases)), Match.exhaustive)
const policyForAction = (authorization: PolicyAuthorization, action: AuthorizationAction) => Option.fromNullishOr(authorization.allow[action])
const actionKnown = (action: string): action is AuthorizationAction => Array.some(AuthorizationActions, (known) => known === action)
const isStruct = (value: unknown): value is AnyStruct => Schema.isSchema(value) && SchemaAST.isObjects(value.ast)

const ruleValidationFor = (authorization: PolicyAuthorization, resource: AnyStruct, subject: AnyStruct) => (action: AuthorizationAction) => {
  const rule = policyForAction(authorization, action)
  const phases = actionPhases(action)
  return pipe(
    rule,
    Option.map((value) => checkPolicy(value, resource, subject, phases, `allow.${action}`)),
  )
}

const checkPolicyDefinition = (authorization: PolicyAuthorization, resource: AnyStruct, subject: AnyStruct) => {
  const schemas = [resource, subject, authorization.resource, authorization.subject]
  const flatSchemas = Array.every(schemas, isStruct)
  if (!flatSchemas) return policyFailure({ reason: "policy authorization requires flat resource and subject struct schemas" })
  if (authorization.resource !== resource) return policyFailure({ reason: "authorization resource schema must match the compiled resource schema" })
  if (authorization.subject !== subject) return policyFailure({ reason: "authorization subject schema must match the declared subject schema" })
  const objectRules = Predicate.isObject(authorization.allow)
  if (!objectRules) return policyFailure({ reason: "policy authorization allow rules must be an object" })

  const actions = Struct.keys(authorization.allow)
  const invalidAction = Array.findFirst(actions, Predicate.not(actionKnown))

  const actionValidation = pipe(
    invalidAction,
    Option.match({
      onNone: Function.constant(Effect.void),
      onSome: (action) => policyFailure({ reason: `policy authorization declares unknown action ${action}` }),
    }),
  )

  const ruleOptions = Array.map(AuthorizationActions, ruleValidationFor(authorization, resource, subject))
  const rules = Array.getSomes(ruleOptions)
  const scopeValidation = checkPolicy(authorization.scope, resource, subject, scopePhases, "scope")
  const ruleValidation = Effect.all(rules, { discard: true })
  return pipe(actionValidation, Effect.andThen(scopeValidation), Effect.andThen(ruleValidation))
}

const snapshotOperand = (operand: Operand): Operand => {
  switch (operand._tag) {
    case "Literal":
      return Object.freeze({
        _tag: "Literal",
        value: Array.isArray(operand.value) ? Object.freeze([...operand.value]) : operand.value,
      }) as Operand
    case "SubjectField":
    case "RowField":
    case "NextField":
      return Object.freeze({ _tag: operand._tag, field: operand.field }) as Operand
  }
}

const snapshotPolicy = (policy: PolicySyntax): PolicySyntax => {
  switch (policy._tag) {
    case "Constant":
      return Object.freeze({ _tag: "Constant", value: policy.value })
    case "Equal":
      return Object.freeze({ _tag: "Equal", left: snapshotOperand(policy.left), right: snapshotOperand(policy.right) })
    case "Includes":
      return Object.freeze({ _tag: "Includes", collection: snapshotOperand(policy.collection), value: snapshotOperand(policy.value) })
    case "All":
    case "Any":
      return Object.freeze({ _tag: policy._tag, children: Object.freeze(Array.map(policy.children, snapshotPolicy)) })
  }
}

const compiledPolicies = new WeakMap<PolicyAuthorization, CompiledAuthorization>()

const constructPolicy = <Resource extends AnyStruct, Subject extends AnyStruct>(
  resource: Resource,
  subject: Subject,
  definition: Readonly<{ readonly scope: PolicySyntax; readonly allow: Partial<Record<AuthorizationAction, PolicySyntax>> }>,
): PolicyAuthorization<Resource, Subject> => {
  const unsealed: PolicyAuthorization<Resource, Subject> = {
    _tag: "Policy",
    resource,
    subject,
    scope: definition.scope,
    allow: definition.allow,
  }
  pipe(checkPolicyDefinition(unsealed, resource, subject), Effect.runSync)

  const entries: Array<readonly [AuthorizationAction, PolicySyntax]> = []
  for (const action of AuthorizationActions) {
    const rule = definition.allow[action]
    if (rule !== undefined) entries.push([action, snapshotPolicy(rule)])
  }
  const allow = Object.freeze(Record.fromEntries(entries) as Partial<Record<AuthorizationAction, PolicySyntax>>)
  const authorization: PolicyAuthorization<Resource, Subject> = Object.freeze({
    _tag: "Policy",
    resource,
    subject,
    scope: snapshotPolicy(definition.scope),
    allow,
  })
  compiledPolicies.set(authorization, make(authorization))
  return authorization
}

const compiledPolicy = (authorization: PolicyAuthorization, resource: AnyStruct) => {
  const compiled = compiledPolicies.get(authorization)
  if (compiled === undefined) return policyFailure({ reason: "policy authorization must be created with Authorization.for(...).policy(...)" })
  return authorization.resource === resource
    ? Effect.succeed(compiled)
    : policyFailure({ reason: "authorization resource schema must match the compiled resource schema" })
}

const matchingDescription = (left: FieldDescription, right: FieldDescription) => {
  const category = Option.makeEquivalence(Equivalence.strictEqual<ScalarCategory>())(left.category, right.category)
  const nullable = left.nullable === right.nullable
  const collection = left.collection === right.collection
  const matchingCategory = category && nullable
  return matchingCategory && collection
}

const validateSubjectBindings = Effect.fn("Authorization.validateSubjectBindings")(function* (
  authorization: AuthorizationDefinition,
  resource: AnyStruct,
  bindings: Readonly<Record<string, unknown>>,
) {
  const fields = Record.keys(bindings)
  if (Array.isReadonlyArrayEmpty(fields)) return
  if (!isPolicyAuthorization(authorization)) {
    return yield* policyFailure({ reason: "create subject bindings require policy authorization" })
  }
  yield* compiledPolicy(authorization, resource)

  const validateBinding = (target: string) => {
    const binding = bindings[target]
    const validOperand = Schema.is(OperandSchema)(binding)
    if (!validOperand) {
      return policyFailure({ reason: `create subject binding ${target} must reference a subject field` })
    }

    const subjectField = Predicate.isTagged(binding, "SubjectField")
    if (!subjectField) {
      return policyFailure({ reason: `create subject binding ${target} must reference a subject field` })
    }

    const destination = fieldFor(resource, target)
    if (Option.isNone(destination)) return policyFailure({ reason: `create subject binding targets unknown field ${target}` })
    const source = fieldFor(authorization.subject, binding.field)
    if (Option.isNone(source)) return policyFailure({ reason: `create subject binding references unknown subject.${binding.field}` })

    const compatible = matchingDescription(destination.value, source.value)
    return compatible
      ? Effect.void
      : policyFailure({ reason: `create subject binding ${target} is incompatible with subject.${binding.field}` })
  }

  yield* Effect.forEach(fields, validateBinding, { discard: true })
})


const hasIdentityEncoding = (schema: Schema.Constraint) => {
  const encoding = Option.fromNullishOr(schema.ast.encoding)
  const noEncoding = Option.isNone(encoding)
  const encodedSchema = Schema.toEncoded(schema)
  return noEncoding && encodedSchema.ast === schema.ast
}

const tableFieldNamed = (table: Table, field: string) => {
  const named = (candidate: Table["fields"][number]) => candidate.name === field
  return Array.findFirst(table.fields, named)
}

const numericStorage = (field: Table["fields"][number]) => {
  return field.scalar === "integer" || field.scalar === "number"
}

const storageCompatible = (description: FieldDescription, field: Table["fields"][number]) => {
  const nullable = description.nullable === field.nullable
  const string = field.scalar === "string"
  const numeric = numericStorage(field)
  const boolean = field.scalar === "integer"

  const supported = pipe(
    description.category,
    Option.match({
      onNone: Function.constant(false),
      onSome: (category) => pipe(
        Match.value(category),
        Match.when("string", Function.constant(string)),
        Match.when("number", Function.constant(numeric)),
        Match.when("boolean", Function.constant(boolean)),
        Match.exhaustive,
      ),
    }),
  )

  return supported && nullable
}

const validate = Effect.fn("Authorization.validateSqlStorage")(function* (authorization: PolicyAuthorization, resource: AnyStruct, storage: AnyStruct, table: Table) {
  if (!isStruct(storage)) return yield* policyFailure({ reason: "SQL policy storage schema must be a flat struct" })
  const readOption = policyForAction(authorization, "read")
  const read = Option.getOrElse(readOption, Function.constant(falsePolicy))
  const visible = Policy.all(authorization.scope, read)

  const validateReference = (reference: Exclude<Operand, { readonly _tag: "Literal" }>) => {
    const rowField = Predicate.isTagged(reference, "RowField")
    if (!rowField) return Effect.void
    const canonical = Option.fromNullishOr(resource.fields[reference.field])
    if (Option.isNone(canonical)) return policyFailure({ reason: `SQL policy references unknown row.${reference.field}` })
    const physical = Option.fromNullishOr(storage.fields[reference.field])
    if (Option.isNone(physical)) return policyFailure({ reason: `SQL policy references unknown row.${reference.field}` })
    const scalar = fieldDescription(canonical.value)
    if (Option.isNone(scalar)) return policyFailure({ reason: `SQL policy references unknown row.${reference.field}` })
    const tableField = tableFieldNamed(table, reference.field)
    if (Option.isNone(tableField)) return policyFailure({ reason: `SQL policy references unknown row.${reference.field}` })

    const identical = canonical.value === physical.value
    if (!identical) return policyFailure({ reason: `SQL policy row.${reference.field} must use an identity storage encoding` })
    const canonicalIdentity = hasIdentityEncoding(canonical.value)
    if (!canonicalIdentity) return policyFailure({ reason: `SQL policy row.${reference.field} must use an identity storage encoding` })
    const physicalIdentity = hasIdentityEncoding(physical.value)
    if (!physicalIdentity) return policyFailure({ reason: `SQL policy row.${reference.field} must use an identity storage encoding` })
    if (scalar.value.collection) return policyFailure({ reason: `SQL policy row.${reference.field} uses an unsupported storage scalar` })

    const compatible = storageCompatible(scalar.value, tableField.value)
    if (!compatible) return policyFailure({ reason: `SQL policy row.${reference.field} does not have a compatible physical scalar` })
    return Effect.void
  }

  const references = Policy.references(visible)
  const validations = Array.map(references, validateReference)
  yield* Effect.all(validations, { discard: true })
})

const currentActions = HashSet.fromIterable<AuthorizationAction>(["read", "remove", "update", "patch"])
const candidateActions = HashSet.fromIterable<AuthorizationAction>(["create", "update", "patch"])
const requiresCurrent = (action: AuthorizationAction) => HashSet.has(currentActions, action)
const requiresCandidate = (action: AuthorizationAction) => HashSet.has(candidateActions, action)

const make = (authorization: PolicyAuthorization): CompiledAuthorization => {
  const scope = Policy.evaluate(authorization.scope)
  const evaluatorEntries: Array<readonly [AuthorizationAction, ReturnType<typeof Policy.evaluate>]> = []
  for (const action of AuthorizationActions) {
    const rule = authorization.allow[action]
    if (rule !== undefined) evaluatorEntries.push([action, Policy.evaluate(rule)])
  }
  const evaluators = Record.fromEntries(evaluatorEntries) as Partial<Record<AuthorizationAction, ReturnType<typeof Policy.evaluate>>>
  const read = evaluators.read
  const visibility = Policy.all(authorization.scope, authorization.allow.read ?? falsePolicy)
  const isSubject = Schema.is(authorization.subject)

  const requireScope = Effect.fn("Authorization.scope")(function* (environment: PolicyEnvironment) {
    if (!(yield* scope(environment))) return yield* forbidden()
  })

  const subject = Effect.fn("Authorization.subject")(function* (action: AuthorizationAction) {
    if (authorization.allow[action] === undefined) return yield* forbidden()
    const supplied = yield* Effect.serviceOption(AuthorizationSubject)
    if (Option.isNone(supplied) || !isSubject(supplied.value)) return yield* unauthenticated()
    return supplied.value
  })

  const check: CompiledAuthorization["check"] = Effect.fn("Authorization.check")(function* (action, subject, values) {
    const rule = evaluators[action]
    if (rule === undefined) return yield* forbidden()
    if (requiresCurrent(action) && values.row === undefined) return yield* forbidden()
    if (requiresCandidate(action) && values.next === undefined) return yield* forbidden()

    if (values.row !== undefined) yield* requireScope({ subject, row: values.row, next: values.next })
    if (values.next !== undefined) yield* requireScope({ subject, row: values.next, next: values.next })

    if (!(yield* rule({ subject, row: values.row, next: values.next }))) return yield* forbidden()
    if (!requiresCandidate(action)) return
    if (read === undefined || values.next === undefined) return yield* forbidden()
    if (!(yield* read({ subject, row: values.next, next: values.next }))) return yield* forbidden()
  })

  return { visibility, subject, check }
}

const publicClaims = Effect.succeed<Readonly<Record<string, unknown>>>({})
const publicSubject = Function.constant(publicClaims)
const publicCheck = Function.constant(Effect.void)

const publicCompiled: CompiledAuthorization = {
  visibility: truePolicy,
  subject: publicSubject,
  check: publicCheck,
}

const denyCompiled: CompiledAuthorization = {
  visibility: falsePolicy,
  subject: forbidden,
  check: forbidden,
}


const standalone = (authorization: AuthorizationDefinition) => {
  if (isPublicAuthorization(authorization)) return Effect.succeed(publicCompiled)
  if (isDenyAuthorization(authorization)) return Effect.succeed(denyCompiled)
  if (!isPolicyAuthorization(authorization)) return policyFailure({ reason: "authorization must be Public, Deny, or Policy" })
  return compiledPolicy(authorization, authorization.resource)
}

export const Authorization = {
  public: publicAuthorization,
  deny: denyAuthorization,
  for: policyDsl,
  validateSubjectBindings,
  compile: Effect.fn("Authorization.compile")(function* (
    options: Readonly<{
      readonly authorization: AuthorizationDefinition
      readonly resource: AnyStruct
      readonly storage: AnyStruct
      readonly table: Table
    }>,
  ) {
    if (isPublicAuthorization(options.authorization)) return publicCompiled
    if (isDenyAuthorization(options.authorization)) return denyCompiled
    if (!isPolicyAuthorization(options.authorization)) {
      return yield* policyFailure({ reason: "authorization must be Public, Deny, or Policy" })
    }
    const compiled = yield* compiledPolicy(options.authorization, options.resource)
    yield* validate(options.authorization, options.resource, options.storage, options.table)
    return compiled
  }),
  require: Effect.fn("Authorization.require")(function* (authorization: AuthorizationDefinition, action: AuthorizationAction, values: AuthorizationValues) {
    const compiled = yield* standalone(authorization)
    const subject = yield* compiled.subject(action)
    yield* compiled.check(action, subject, values)
  }),
}
