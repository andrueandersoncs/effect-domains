import { Context, Effect, Layer, Option, Schema, pipe } from "effect"
import type { Headers } from "effect/unstable/http"
import { RpcMiddleware } from "effect/unstable/rpc"
import { Authorization, AuthorizationSubject, Forbidden, Unauthenticated, type SubjectPolicy } from "./authorization.ts"
import { EntitlementRequired, EntitlementUnavailable } from "./entitlements.ts"

class Authenticator extends Context.Service<Authenticator, {
  readonly authenticate: (headers: Headers.Headers) => Effect.Effect<Readonly<Record<string, unknown>>, Unauthenticated>
}>()("@effect-domains/Authenticator") {}

class RpcSubjectPolicy extends Context.Service<RpcSubjectPolicy, SubjectPolicy>()("@effect-domains/RpcSubjectPolicy") {}
const authenticationErrorsSchema = Schema.Union([Unauthenticated, Forbidden, EntitlementRequired, EntitlementUnavailable])

export class AuthorizationRpc extends RpcMiddleware.Service<AuthorizationRpc, {
  provides: AuthorizationSubject
}>()("@effect-domains/AuthorizationRpc", { error: authenticationErrorsSchema }) {
  static readonly Authenticator = Authenticator
  static readonly policy = RpcSubjectPolicy

  static readonly layer = Layer.succeed(AuthorizationRpc, AuthorizationRpc.of(
    Effect.fn("AuthorizationRpc.authenticate")(function* (effect, metadata) {
      const authenticator = yield* Effect.serviceOption(Authenticator)
      if (Option.isNone(authenticator)) return yield* Unauthenticated.make({})
      const subject = yield* authenticator.value.authenticate(metadata.headers)
      const policy = Context.getOption(metadata.rpc.annotations, RpcSubjectPolicy)

      const authorized = Option.match(policy, {
        onNone: () => effect,
        onSome: (policy) => pipe(Authorization.requireSubject(policy), Effect.andThen(effect)),
      })

      return yield* Effect.provideService(authorized, AuthorizationSubject, subject)
    }),
  ))
}
