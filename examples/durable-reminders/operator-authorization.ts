import { Array, Effect, Layer, Schema } from "effect"
import { Forbidden, Unauthenticated } from "effect-domains/authorization"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { RpcMiddleware } from "effect/unstable/rpc"

const isOperator = (subject: Readonly<Record<string, unknown>>) =>
  Array.isArray(subject.roles) && Array.contains(subject.roles, "admin")

const operatorErrorSchema = Schema.Union([Unauthenticated, Forbidden])

export class OperatorAuthorization extends RpcMiddleware.Service<OperatorAuthorization>()(
  "examples/durable-reminders/OperatorAuthorization",
  { error: operatorErrorSchema },
) {
  static readonly make = Effect.gen(function* () {
    const authenticator = yield* AuthorizationRpc.Authenticator

    return OperatorAuthorization.of(
      Effect.fn("DurableReminders.authorizeOperator")(function* (effect, metadata) {
        const subject = yield* authenticator.authenticate(metadata.headers)

        if (!isOperator(subject)) {
          return yield* Forbidden.make({})
        }

        return yield* effect
      }),
    )
  })

  static readonly layer = Layer.effect(OperatorAuthorization, OperatorAuthorization.make)
}
