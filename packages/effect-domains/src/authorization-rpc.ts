import { Context, Effect, Layer, Option, Schema, pipe } from "effect"
import type { Headers } from "effect/unstable/http"
import { RpcMiddleware } from "effect/unstable/rpc"
import { Authorization, AuthorizationSubject, Forbidden, Unauthenticated, type SubjectPolicy } from "./authorization.ts"
import { EntitlementRequired, EntitlementUnavailable } from "./entitlements.ts"
import { IdentityUnavailable } from "./identity.ts"

class Authenticator extends Context.Service<Authenticator, {
  readonly authenticate: (headers: Headers.Headers) => Effect.Effect<AuthorizationSubject["Service"], Unauthenticated | IdentityUnavailable>
}>()("@effect-domains/Authenticator") {}

class RpcSubjectPolicy extends Context.Service<RpcSubjectPolicy, SubjectPolicy>()("@effect-domains/RpcSubjectPolicy") {}

const AuthenticationErrorsSchema = Schema.Union([Unauthenticated, IdentityUnavailable, Forbidden, EntitlementRequired, EntitlementUnavailable])

export class AuthorizationRpc extends RpcMiddleware.Service<AuthorizationRpc, {
  provides: AuthorizationSubject
}>()("@effect-domains/AuthorizationRpc", { error: AuthenticationErrorsSchema }) {
  static readonly Authenticator = Authenticator
  static readonly policy = RpcSubjectPolicy
  static readonly errorSchema = AuthenticationErrorsSchema

  static readonly layer = Layer.succeed(AuthorizationRpc, AuthorizationRpc.of(
    Effect.fn("AuthorizationRpc.authenticate")(function* (effect, metadata) {
      const authenticator = yield* Effect.serviceOption(Authenticator)

      if (Option.isNone(authenticator)) return yield* Unauthenticated.make({})

      const authenticated = yield* authenticator.value.authenticate(metadata.headers)
      const policy = Context.getOption(metadata.rpc.annotations, RpcSubjectPolicy)

      const authorized = Option.match(policy, {
        onNone: () => effect,
        onSome: (policy) => pipe(Authorization.requireSubject(policy), Effect.andThen(effect)),
      })

      return yield* pipe(
        authorized,
        Effect.provideService(AuthorizationSubject, authenticated),
      )
    }),
  ))
}
