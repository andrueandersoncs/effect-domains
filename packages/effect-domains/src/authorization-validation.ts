import { Array, Data, Effect, Function, HashSet, Match, Option, Predicate, Record, Schema, Struct, flow, pipe } from "effect"
import type { StructSchema } from "./domain.ts"
import { Entitlements, EntitlementRequired, EntitlementUnavailable } from "./entitlements.ts"
import { Policy, PolicyEnvironment, type Operand, type Policy as PolicySyntax, type PolicyF } from "./policy.ts"
import { type FieldIR, SchemaField, type FieldCategory } from "./schema-field.ts"

import {
  actions,
  type AuthorizationAction,
  AuthorizationDefinitionError,
  AuthorizationSubject,
  definitionError,
  emptyEntitlementRequirements,
  emptyEntitlements,
  equals,
  type EntitlementRequirement,
  type EntitlementRequirements,
  failure,
  type FieldDescriptions,
  Forbidden,
  type PolicyPhase,
  PolicyFields,
  type SubjectPolicy,
} from "./authorization-model.ts"

const describeFields = (schema: StructSchema): FieldDescriptions =>
  Record.map(schema.fields, SchemaField.compile)

const findFieldDescription = (fields: FieldDescriptions, field: string) => pipe(Record.get(fields, field), Option.flatten)

const compatibleFieldCategory = (left: FieldIR["category"], right: FieldIR["category"]) => {
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

  return pipe(findFieldDescription(fieldSchema, operand.field), Option.match({
    onNone: () => failure(`${phase}.${operand.field} must be a known finite scalar or scalar collection field`),
    onSome: Effect.succeed,
  }))
}

const describeLiteral = (literal: Extract<Operand, { readonly _tag: "Literal" }>) => {
  const description = SchemaField.describeValue(literal.value)

  return Option.match(description, {
    onNone: () => failure("policy literal must contain only finite scalar values"),
    onSome: Effect.succeed,
  })
}

const describeOperand = (operand: Operand, fields: PolicyFields, allowed: HashSet.HashSet<PolicyPhase>) => pipe(
  Match.value(operand),
  Match.tag("Literal", describeLiteral),
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
  const collectionMatches = equals(leftDescription.collection, inclusion)
  const validOperands = collectionMatches && scalarValue

  if (!validOperands) return yield* failure(inclusion ? `${label} includes requires a scalar collection and scalar value` : `${label} equality operands must be scalar`)
  if (!compatibleFieldCategory(leftDescription.category, rightDescription.category)) return yield* failure(`${label} ${inclusion ? "includes" : "equality"} operands must have the same scalar type`)
})

const checkPolicy = (policy: PolicySyntax, fields: PolicyFields, allowed: HashSet.HashSet<PolicyPhase>, label: string) => {
  const validate = (layer: PolicyF<Effect.Effect<void, AuthorizationDefinitionError, never>>) => pipe(
    Match.value(layer),
    Match.tagsExhaustive({
      Constant: Function.constant(Effect.void),
      Equal: ({ left, right }) => checkPair(left, right, fields, allowed, label, false),
      Includes: ({ collection, value }) => checkPair(collection, value, fields, allowed, label, true),
      All: ({ children }) => Effect.all(children, { discard: true }),
      Any: ({ children }) => Effect.all(children, { discard: true }),
    }),
  )

  return Policy.fold<Effect.Effect<void, AuthorizationDefinitionError, never>>(validate)(policy)
}

const validateEntitlements = (requirements: ReadonlyArray<EntitlementRequirement>, fields: PolicyFields, phases: HashSet.HashSet<PolicyPhase>) =>
  Effect.forEach(requirements, Effect.fn("Authorization.validateEntitlement")(function* (requirement) {
    const description = yield* describeOperand(requirement.key, fields, phases)
    const stringKey = Option.contains(description.category, "string")
    const invalidKeyKind = description.nullable || description.collection
    const nonString = !stringKey
    const invalidKey = nonString || invalidKeyKind

    if (invalidKey) return yield* failure("entitlement key must be a required string")
  }), { discard: true })

const snapshotEntitlement = ({ name, key }: EntitlementRequirement) => {
  const frozenKey = Object.freeze({ ...key })

  return Object.freeze({ name, key: frozenKey })
}

const snapshotEntitlements = flow(
  Array.map(snapshotEntitlement),
  Object.freeze,
)

const scalarOperandValue = (operand: Operand, environment: PolicyEnvironment) => pipe(
  Match.value(operand),
  Match.tagsExhaustive({
    Literal: ({ value }) => value,
    SubjectField: ({ field }) => environment.subject[field],
    RowField: ({ field }) => Option.getOrUndefined(environment.row)?.[field],
    NextField: ({ field }) => Option.getOrUndefined(environment.next)?.[field],
  }),
)

const checkEntitlements = (requirements: ReadonlyArray<EntitlementRequirement>, environment: PolicyEnvironment) =>
  Effect.forEach(requirements, Effect.fn("Authorization.entitlement")(function* (requirement) {
    const key = scalarOperandValue(requirement.key, environment)

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

const isSubjectPolicy = <Value>(value: Value): value is Value & SubjectPolicy =>
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

type ResolvedPolicyEffect = Effect.Effect<ResolvedPolicy, AuthorizationDefinitionError, never>

const unregisteredSubjectPolicy: ResolvedPolicyEffect = failure("subject policy must be constructed by Authorization.subject")
const foreignSubjectPolicy: ResolvedPolicyEffect = failure("subject policy subject schema must match the authorization subject schema")

const resolvedPolicy = (
  expression: PolicySyntax,
  require: ReadonlyArray<EntitlementRequirement>,
): ResolvedPolicyEffect => pipe(
  new ResolvedPolicy({ expression, require }),
  Effect.succeed,
)

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

export {
  checkEntitlements,
  isRegisteredSubjectPolicy,
  RegisteredSubjectPolicy,
  checkPolicy,
  describeFields,
  normalizePolicyDefinition,
  requirementsFor,
  snapshotEntitlements,
  subjectEntitlement,
  validateEntitlements,
}
