import { Effect, Layer, Schema } from "effect"
import { Headers } from "effect/unstable/http"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Forbidden, Unauthenticated } from "../authorization/model.ts"

import {
  AccountAlreadyExists, AccountNotFound, CredentialsSchema, CurrentSessionSchema, IdentityRuntime,
  IdentityUnavailable, InvalidInviteToken, InvalidPasswordResetToken, IssuedInviteSchema,
  IssuedPasswordResetSchema, IssuedSessionSchema, PasswordResetRequestSchema, PasswordResetSchema,
  SignupSchema,
} from "./index.ts"

import { authenticateIdentity } from "./authenticate.ts"
import { GroupHandlers, GroupRpcs } from "./groups/rpc.ts"
import { RpcBundle } from "../rpc/contract.ts"

const IdentityErrorsSchema = Schema.Union([Unauthenticated, IdentityUnavailable])
const InviteErrorsSchema = Schema.Union([Unauthenticated, Forbidden, IdentityUnavailable])

const SignupErrorsSchema = Schema.Union([AccountAlreadyExists, InvalidInviteToken])
const IssuePasswordResetErrorsSchema = Schema.Union([Unauthenticated, Forbidden, AccountNotFound])

const identityRequestRpc = <
  const Tag extends string,
  Payload extends Schema.Top,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(tag: Tag, payload: Payload, success: Success, error: Error) => {
  const errorSchema = Schema.Union([error, IdentityUnavailable])

  return Rpc.make(tag, { payload, success, error: errorSchema })
}

const login = identityRequestRpc("identity.login", CredentialsSchema, IssuedSessionSchema, Unauthenticated)

const signup = identityRequestRpc(
  "identity.signup",
  SignupSchema,
  IssuedSessionSchema,
  SignupErrorsSchema,
)

const close = Rpc.make("identity.close", { success: Schema.Void, error: IdentityErrorsSchema })

const issueInvite = Rpc.make("identity.issueInvite", {
  success: IssuedInviteSchema,
  error: InviteErrorsSchema,
})

const issuePasswordReset = identityRequestRpc(
  "identity.issuePasswordReset",
  PasswordResetRequestSchema,
  IssuedPasswordResetSchema,
  IssuePasswordResetErrorsSchema,
)

const resetPassword = identityRequestRpc(
  "identity.resetPassword",
  PasswordResetSchema,
  Schema.Void,
  InvalidPasswordResetToken,
)

const current = Rpc.make("identity.current", { success: CurrentSessionSchema, error: IdentityErrorsSchema })
const logout = Rpc.make("identity.logout", { success: Schema.Void, error: IdentityErrorsSchema })
const CoreIdentityRpcs = RpcGroup.make(login, current, logout, signup, close, issueInvite, issuePasswordReset, resetPassword)
export const IdentityRpcs = CoreIdentityRpcs.merge(GroupRpcs)

const loginHandler = Effect.fn("Identity.login")(function* (credentials: Schema.Schema.Type<typeof CredentialsSchema>) {
  const identity = yield* IdentityRuntime

  return yield* identity.login(credentials)
})

const signupHandler = Effect.fn("Identity.signup")(function* (credentials: Schema.Schema.Type<typeof SignupSchema>) {
  const identity = yield* IdentityRuntime

  return yield* identity.signup(credentials)
})

const closeHandler = Effect.fn("Identity.close")(function* (headers: Headers.Headers) {
  const authenticated = yield* authenticateIdentity(headers)
  const identity = yield* IdentityRuntime

  yield* identity.close(authenticated.username)
})

const issueInviteHandler = Effect.fn("Identity.issueInvite")(function* (headers: Headers.Headers) {
  const authenticated = yield* authenticateIdentity(headers)
  const identity = yield* IdentityRuntime

  return yield* identity.issueInvite(authenticated)
})

const issuePasswordResetHandler = Effect.fn("Identity.issuePasswordReset")(function* (
  request: Schema.Schema.Type<typeof PasswordResetRequestSchema>,
  headers: Headers.Headers,
) {
  const authenticated = yield* authenticateIdentity(headers)
  const identity = yield* IdentityRuntime

  return yield* identity.issuePasswordReset(request, authenticated)
})

const resetPasswordHandler = Effect.fn("Identity.resetPassword")(function* (
  request: Schema.Schema.Type<typeof PasswordResetSchema>,
) {
  const identity = yield* IdentityRuntime

  yield* identity.resetPassword(request)
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

const CoreIdentityHandlers = CoreIdentityRpcs.toLayer({
  "identity.login": loginHandler,
  "identity.current": (_payload, { headers }) => currentHandler(headers),
  "identity.logout": (_payload, { headers }) => logoutHandler(headers),
  "identity.signup": signupHandler,
  "identity.close": (_payload, { headers }) => closeHandler(headers),
  "identity.issueInvite": (_payload, { headers }) => issueInviteHandler(headers),
  "identity.issuePasswordReset": (request, { headers }) => issuePasswordResetHandler(request, headers),
  "identity.resetPassword": resetPasswordHandler,
})

export const IdentityHandlers = Layer.merge(CoreIdentityHandlers, GroupHandlers)

export const IdentityBundle = RpcBundle.make(IdentityRpcs)(IdentityHandlers)
