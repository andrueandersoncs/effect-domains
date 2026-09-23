import { Array, Data, Effect, Function, HashSet, Match, Option, Predicate, Record, Schema, Struct, flow, pipe } from "effect"
import type { StructSchema, StructValue } from "./domain.ts"
import { EntitlementRequired, EntitlementUnavailable } from "./entitlements.ts"
import { OperandSchema, Policy, PolicyEnvironment, type Operand, type Policy as PolicySyntax } from "./policy.ts"
import { FieldIR, SchemaField } from "./schema-field.ts"
import type { Table } from "./table.ts"

import {
  actions,
  type AuthorizationAction,
  type AuthorizationDefinition,
  AuthorizationDefinitionError,
  type AuthorizationRuntime,
  AuthorizationSubject,
  AuthorizationValues,
  changePhases,
  createPhases,
  defaultReadPolicy,
  definitionError,
  denyAuthorization,
  emptyEntitlementRequirements,
  emptyEntitlements,
  equals,
  type EntitlementMap,
  type EntitlementRequirement,
  type EntitlementRequirements,
  failure,
  falsePolicy,
  type FieldDescriptions,
  Forbidden,
  forbidden,
  forbiddenError,
  isDenyAuthorization,
  isPolicyAuthorization,
  isPublicAuthorization,
  isStruct,
  type PolicyAuthorization,
  type PolicyExpression,
  PolicyAuthorizationSchema,
  type PolicyPhase,
  PolicyFields,
  publicAuthorization,
  scopePhases,
  type SubjectPolicy,
  truePolicy,
  unauthenticatedError,
} from "./authorization-model.ts"

import {
  checkEntitlements,
  checkPolicy,
  describeFields,
  isRegisteredSubjectPolicy,
  normalizePolicyDefinition,
  RegisteredSubjectPolicy,
  requirementsFor,
  snapshotEntitlements,
  subjectEntitlement,
  validateEntitlements,
} from "./authorization-validation.ts"

const subjectPhases = HashSet.fromIterable<PolicyPhase>(["subject"])
const absentPolicyRow = Option.none<StructValue>()

const fieldFor = (fields: FieldDescriptions, field: string): Option.Option<FieldIR> =>
  pipe(Record.get(fields, field), Option.flatten)

const sameFieldCategory = (left: FieldIR["category"], right: FieldIR["category"]): boolean =>
  Option.match(left, {
    onNone: () => Option.isNone(right),
    onSome: (category) => Option.exists(right, equals(category)),
  })

const requireSubject = <Subject extends StructSchema, Requirements extends ReadonlyArray<EntitlementRequirement>>(policy: SubjectPolicy<Subject, Requirements>) => {
  const effect = isRegisteredSubjectPolicy(policy)
    ? policy[RegisteredSubjectPolicy](policy)
    : pipe(definitionError("subject policy must be constructed by Authorization.subject"), Effect.die)

  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  return effect as Effect.Effect<Subject["Type"], Requirements extends readonly [] ? Forbidden : Forbidden | EntitlementRequired | EntitlementUnavailable, AuthorizationSubject>
}

const policyFor = (authorization: PolicyAuthorization, action: AuthorizationAction): Option.Option<PolicySyntax> =>
  Option.fromNullishOr(authorization.allow[action])

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

type RegisteredPolicy = PolicyAuthorization & Readonly<Record<typeof RegisteredAuthorization, (candidate: PolicyAuthorization) => Effect.Effect<Registration, AuthorizationDefinitionError, never>>>

const isRegisteredPolicy = (value: PolicyAuthorization): value is RegisteredPolicy => Predicate.hasProperty(value, RegisteredAuthorization)

const makeScopeCheck = (scope: ReturnType<typeof Policy.evaluate>) =>
  Effect.fn("Authorization.scope")(function* (
    subject: StructValue,
    row: Option.Option<StructValue>,
    next: Option.Option<StructValue>,
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
): AuthorizationRuntime["subject"] => {
  const isSubject = Schema.is(subjectSchema)
  const subjectRequirements = (entries: EntitlementMap[string]) => Array.filter(entries ?? emptyEntitlements, subjectEntitlement)
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const preflight = Record.map(requirements as EntitlementMap /* SAFETY: The map contract matches because requirements were normalized from the same entitlement declaration. */, subjectRequirements)
  const subjectReference = (reference: Exclude<Operand, { readonly _tag: "Literal" }>) => Predicate.isTagged(reference, "SubjectField")
  const subjectOnly = flow(Policy.references, Array.every(subjectReference))
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const subjectRules = Record.filter(rules, (_, action) => subjectOnly(policies[action] as PolicySyntax))
  const unrestricted = Policy.evaluate(truePolicy)

  return (action: AuthorizationAction) => Effect.gen(function* () {
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

    yield* checkEntitlements(required, environment)

    return subject
  })
}

const makeCheck = (
  rules: Readonly<Record<string, ReturnType<typeof Policy.evaluate>>>,
  scopeCheck: ReturnType<typeof makeScopeCheck>,
  requirements: EntitlementRequirements,
): AuthorizationRuntime["check"] =>
  (action: AuthorizationAction, subject: StructValue, values: AuthorizationValues) => Effect.gen(function* () {
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

    yield* Effect.forEach(actions, (action) => Effect.gen(function* () {
      const required = requirementsFor(source.require ?? emptyEntitlementRequirements, action)
      const missingPolicy = pipe(policyFor(source, action), Option.isNone)
      const missingGrant = required.length > 0 && missingPolicy

      if (missingGrant) return yield* failure(`require.${action} needs an allow.${action} policy`)

      const [phases] = actionRequirements(action)

      yield* validateEntitlements(required, fields, phases)
    }), { discard: true })
  })

  Effect.runSync(validation)

  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const mappedAllow = Record.map(source.allow as Readonly<Record<string, PolicySyntax>>, Policy.snapshot)
  const allow = Object.freeze(mappedAllow)
  const scope = Policy.snapshot(source.scope)
  const snapshotEntries = (entries: EntitlementMap[string]) => snapshotEntitlements(entries ?? emptyEntitlements)
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding entitlement declaration.
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

const registeredPolicy = (
  authorization: PolicyAuthorization,
  resource: StructSchema,
): Effect.Effect<Registration, AuthorizationDefinitionError, never> => {
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
  const fieldKindsCompatible = category && collection

  return fieldKindsCompatible && nullable
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

const validateSubjectBindings = Effect.fn("Authorization.validateSubjectBindings")(function* (authorization: AuthorizationDefinition, resource: StructSchema, bindings: StructValue) {
  if (Record.isEmptyRecord(bindings)) return
  if (!isPolicyAuthorization(authorization)) return yield* failure("create subject bindings require policy authorization")

  const registered = yield* registeredPolicy(authorization, resource)
  const entries = Record.toEntries(bindings)

  yield* Effect.forEach(entries, ([target, binding]) => validateSubjectBinding(registered.fields, target, binding), { discard: true })
})

const hasIdentityEncoding = (schema: Schema.Constraint) => {
  const encoding = Option.fromNullishOr(schema.ast.encoding)
  if (Option.isSome(encoding)) return false
  const encoded = Schema.toEncoded(schema)
  return equals(encoded.ast, schema.ast)
}

const tableField = (table: Table, name: string) =>
  Array.findFirst(table.fields, (field) => field.name === name)

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

const publicSubjectEffect: Effect.Effect<StructValue, never, never> = Effect.succeed({})
const publicSubject: AuthorizationRuntime["subject"] = Function.constant(publicSubjectEffect)
const publicCheck: AuthorizationRuntime["check"] = Function.constant(Effect.void)

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

const publicAccessEffect: Effect.Effect<AuthorizationRuntime, never, never> = Effect.succeed(publicAccess)
const denyAccessEffect: Effect.Effect<AuthorizationRuntime, never, never> = Effect.succeed(denyAccess)
const compileStandalonePolicy = (policy: PolicyAuthorization): Effect.Effect<AuthorizationRuntime, AuthorizationDefinitionError, never> =>
  compiledPolicy(policy, policy.resource)

const standalone = (
  authorization: AuthorizationDefinition,
): Effect.Effect<AuthorizationRuntime, AuthorizationDefinitionError, never> => pipe(
  Match.value(authorization),
  Match.when(isPublicAuthorization, Function.constant(publicAccessEffect)),
  Match.when(isDenyAuthorization, Function.constant(denyAccessEffect)),
  Match.when(isPolicyAuthorization, compileStandalonePolicy),
  Match.orElse(() => failure("authorization must be Public, Deny, or Policy")),
)

export {
  absentPolicyRow,
  subjectPhases,
  constructPolicy,
  registeredPolicy,
  requireSubject,
  standalone,
  validateSqlStorage,
  validateSubjectBindings,
}
