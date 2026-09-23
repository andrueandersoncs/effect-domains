import { Array, Effect, Schema, pipe } from "effect"
import type { StructSchema } from "./domain.ts"
import { Policy, PolicyEnvironment, type Operand, type Scalar } from "./policy.ts"

import {
  all,
  any,
  type AuthorizationAction,
  AuthorizationSubject,
  type Comparable,
  definitionError,
  emptyEntitlements,
  EntitlementListSchema,
  entitlement,
  eq,
  equals,
  expression,
  type FieldName,
  type FieldValue,
  forbidden,
  literalOperand,
  membership,
  policyFields,
  PolicyFields,
  type PolicyExpression,
  type ScalarOnlyFieldName,
  type SubjectPolicy,
  type TypedEntitlement,
  type TypedEntitlementRequirements,
} from "./authorization-model.ts"

import {
  checkEntitlements,
  checkPolicy,
  describeFields,
  RegisteredSubjectPolicy,
  snapshotEntitlements,
  validateEntitlements,
} from "./authorization-validation.ts"
import { absentPolicyRow, constructPolicy, subjectPhases } from "./authorization-runtime.ts"

const policyDsl = <Resource extends StructSchema, Subject extends StructSchema>(
  schemas: Readonly<{ readonly resource: Resource; readonly subject: Subject }>,
) => {
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
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    Policy.EqualSchema.make({ left: row[field] as Operand, right: subject[field] as Operand }),
    expression<"row" | "subject">,
  )

  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const unchangedField = (field: ScalarOnlyFieldName<Resource>) =>
    Policy.EqualSchema.make({ left: row[field] as Operand, right: next[field] as Operand })

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
  }>>(
    definition: Readonly<{
      readonly scope: PolicyExpression<"row" | "subject"> | SubjectPolicy<Subject>
      readonly allow: Allow
    }> & Readonly<Partial<{
      require: Pick<TypedEntitlementRequirements, Extract<keyof NoInfer<Allow>, AuthorizationAction>>
    }>>,
  ) => constructPolicy(schemas.resource, schemas.subject, definition)

  return {
    subject,
    row,
    next,
    eq,
    includes: membership,
    all,
    any,
    sameAs,
    unchanged,
    policy,
    entitlement,
    literal: literalOperand,
  }
}

const subjectPolicyDsl = <Subject extends StructSchema>(subject: Subject) => {
  const subjectFields = describeFields(subject)
  const fields = new PolicyFields({ resource: {}, subject: subjectFields })
  const isSubject = Schema.is(subject)

  const policy = <const Requirements extends ReadonlyArray<TypedEntitlement<"subject">> = readonly []>(
    condition: PolicyExpression<"subject">,
    options: Readonly<Partial<{ require: Requirements }>> = {},
  ) => {
    pipe(
      checkPolicy(condition, fields, subjectPhases, "subject policy"),
      Effect.runSync,
    )

    const decodedRequirements = EntitlementListSchema.make(options.require ?? emptyEntitlements)

    pipe(
      validateEntitlements(decodedRequirements, fields, subjectPhases),
      Effect.runSync,
    )

    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    const required = snapshotEntitlements(decodedRequirements) as Requirements
    const snapshot = pipe(condition, Policy.snapshot, expression<"subject">)
    const evaluate = Policy.evaluate(snapshot)

    const require = Effect.gen(function* () {
      const claims = yield* AuthorizationSubject

      if (!isSubject(claims)) return yield* forbidden()

      const environment = new PolicyEnvironment({
        subject: claims,
        row: absentPolicyRow,
        next: absentPolicyRow,
      })
      const allowed = yield* pipe(
        evaluate(environment),
        Effect.catchTag("PolicyEvaluationError", forbidden),
      )

      if (!allowed) return yield* forbidden()

      yield* checkEntitlements(required, environment)

      return claims
    })

    const invalidRegistration = pipe(
      definitionError("subject policy registration does not match its definition"),
      Effect.die,
    )
    const registration = (candidate: SubjectPolicy<Subject>) =>
      equals(candidate, registered) ? require : invalidRegistration
    const registered = Object.freeze({
      subject,
      expression: snapshot,
      require: required,
      [RegisteredSubjectPolicy]: registration,
    })

    return registered
  }

  return {
    subject: policyFields<Subject, "SubjectField", "subject">(subject, "SubjectField"),
    eq,
    includes: membership,
    all,
    any,
    literal: literalOperand,
    entitlement,
    policy,
  }
}

export { policyDsl, subjectPolicyDsl }
