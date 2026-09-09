import { Context, Effect, Layer, Option } from "effect"
import type { Headers } from "effect/unstable/http"
import { RpcMiddleware } from "effect/unstable/rpc"
import { AuthorizationSubject, Unauthenticated } from "./authorization.ts"

export class Authenticator extends Context.Service<Authenticator, {
  readonly authenticate: (headers: Headers.Headers) => Effect.Effect<Readonly<Record<string, unknown>>, Unauthenticated>
}>()("@effect-domains/Authenticator") {}

export class AuthorizationRpc extends RpcMiddleware.Service<AuthorizationRpc, {
  provides: AuthorizationSubject
}>()("@effect-domains/AuthorizationRpc", { error: Unauthenticated }) {
  static readonly layer = Layer.succeed(AuthorizationRpc, AuthorizationRpc.of(
    Effect.fn("AuthorizationRpc.authenticate")(function* (effect, metadata) {
      const authenticator = yield* Effect.serviceOption(Authenticator)
      if (Option.isNone(authenticator)) return yield* Unauthenticated.make({})
      const subject = yield* authenticator.value.authenticate(metadata.headers)
      return yield* Effect.provideService(effect, AuthorizationSubject, subject)
    }),
  ))
}
