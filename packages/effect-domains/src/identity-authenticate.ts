import { Effect, Option } from "effect"
import { Headers } from "effect/unstable/http"
import { Unauthenticated } from "./authorization-model.ts"
import { IdentityRuntime } from "./identity.ts"

const bearerToken = /^Bearer ([^\s]+)$/i

export const authenticateIdentity = Effect.fn("Identity.authenticate")(function* (headers: Headers.Headers) {
  const authorization = Headers.get(headers, "authorization")

  const token = Option.flatMap(authorization, (value) => {
    const match = bearerToken.exec(value)

    return Option.fromNullishOr(match?.[1])
  })

  if (Option.isNone(token)) return yield* Unauthenticated.make({})

  const identity = yield* IdentityRuntime

  return yield* identity.authenticate(token.value)
})
