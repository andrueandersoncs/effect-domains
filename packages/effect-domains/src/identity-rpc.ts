import { Array, Effect, Option, Record, Schema, String, Struct, pipe } from "effect"
import { Headers } from "effect/unstable/http"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Unauthenticated } from "./authorization.ts"
import { CredentialsSchema, CurrentSessionSchema, IdentityRuntime, IdentityUnavailable, IssuedSessionSchema } from "./identity.ts"
import type { RpcBundle } from "./rpc-contract.ts"

export const authenticateIdentity = Effect.fn("Identity.authenticate")(function* (headers: Headers.Headers) {
  const token = pipe(
    Headers.get(headers, "authorization"),
    Option.flatMap(String.match(/^Bearer ([^\s]+)$/i)),
    Option.flatMap(Array.get(1)),
  )

  if (Option.isNone(token)) return yield* Unauthenticated.make({})
  const identity = yield* IdentityRuntime
  return yield* identity.authenticate(token.value)
})

const IdentityErrorsSchema = Schema.Union([Unauthenticated, IdentityUnavailable])

const login = Rpc.make("identity.login", {
  payload: CredentialsSchema,
  success: IssuedSessionSchema,
  error: IdentityErrorsSchema,
})

const current = Rpc.make("identity.current", { success: CurrentSessionSchema, error: IdentityErrorsSchema })
const logout = Rpc.make("identity.logout", { success: Schema.Void, error: IdentityErrorsSchema })
export const IdentityRpcs = RpcGroup.make(login, current, logout)

const loginHandler = Effect.fn("Identity.login")(function* (credentials: Schema.Schema.Type<typeof CredentialsSchema>) {
  const identity = yield* IdentityRuntime
  return yield* identity.login(credentials)
})

const currentHandler = Effect.fn("Identity.current")(function* (headers: Headers.Headers) {
  const identity = yield* authenticateIdentity(headers)
  return CurrentSessionSchema.make({ expiresAt: identity.expiresAt, subject: identity.subject })
})

const logoutHandler = Effect.fn("Identity.logout")(function* (headers: Headers.Headers) {
  const authenticated = yield* authenticateIdentity(headers)
  const identity = yield* IdentityRuntime
  yield* identity.revoke(authenticated.sessionId)
})

export const IdentityHandlers = IdentityRpcs.toLayer({
  "identity.login": loginHandler,
  "identity.current": (_payload, { headers }) => currentHandler(headers),
  "identity.logout": (_payload, { headers }) => logoutHandler(headers),
})

const emptyBundle = Record.empty<string, never>()
export const IdentityBundle = Struct.assign(emptyBundle, { group: IdentityRpcs, handlers: IdentityHandlers }) satisfies RpcBundle
