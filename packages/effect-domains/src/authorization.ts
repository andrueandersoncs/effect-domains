import { Effect } from "effect"
import type { StructSchema } from "./domain.ts"
import type { Table } from "./table-relations.ts"

import {
  type AuthorizationAction,
  type AuthorizationDefinition,
  AuthorizationValues,
  denyAuthorization,
  isPolicyAuthorization,
  publicAuthorization,
} from "./authorization-model.ts"

import { policyDsl, subjectPolicyDsl } from "./authorization-dsl.ts"

import {
  registeredPolicy,
  requireSubject,
  standalone,
  validateSqlStorage,
  validateSubjectBindings,
} from "./authorization-runtime.ts"

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
