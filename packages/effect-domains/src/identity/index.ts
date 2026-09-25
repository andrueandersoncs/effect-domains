import { Context, type Effect, Schema } from "effect"
import type { Forbidden, Unauthenticated } from "../authorization/model.ts"

const UsernameSchema = Schema.NonEmptyString.check(Schema.isMaxLength(320))
const PasswordSchema = Schema.NonEmptyString.check(Schema.isMaxLength(1024))

export class IdentityUnavailable extends Schema.TaggedError<IdentityUnavailable>()("IdentityUnavailable", {}) {}
export class AccountAlreadyExists extends Schema.TaggedError<AccountAlreadyExists>()("AccountAlreadyExists", {}) {}
export class AccountNotFound extends Schema.TaggedError<AccountNotFound>()("AccountNotFound", {}) {}
export class InvalidPasswordResetToken extends Schema.TaggedError<InvalidPasswordResetToken>()("InvalidPasswordResetToken", {}) {}
export class InvalidInviteToken extends Schema.TaggedError<InvalidInviteToken>()("InvalidInviteToken", {}) {}

export const SubjectSchema = Schema.Record(Schema.String, Schema.Unknown)

export const CredentialsSchema = Schema.Struct({
  username: UsernameSchema,
  password: Schema.Redacted(PasswordSchema),
})

export const SignupSchema = Schema.Struct({
  ...CredentialsSchema.fields,
  inviteToken: Schema.optionalKey(Schema.Redacted(Schema.NonEmptyString)),
})

export const PasswordResetRequestSchema = Schema.Struct({ username: UsernameSchema })

export const PasswordResetSchema = Schema.Struct({
  token: Schema.Redacted(Schema.NonEmptyString),
  password: Schema.Redacted(PasswordSchema),
})

export const IssuedPasswordResetSchema = Schema.Struct({ token: Schema.Redacted(Schema.String) })
export const IssuedInviteSchema = Schema.Struct({ token: Schema.Redacted(Schema.String) })

interface PasswordResetRequest extends Schema.Schema.Type<typeof PasswordResetRequestSchema> {}
interface PasswordReset extends Schema.Schema.Type<typeof PasswordResetSchema> {}
interface IssuedPasswordReset extends Schema.Schema.Type<typeof IssuedPasswordResetSchema> {}
interface Credentials extends Schema.Schema.Type<typeof CredentialsSchema> {}
interface Signup extends Schema.Schema.Type<typeof SignupSchema> {}
interface IssuedInvite extends Schema.Schema.Type<typeof IssuedInviteSchema> {}

export const IssuedSessionSchema = Schema.Struct({
  token: Schema.Redacted(Schema.String),
  expiresAt: Schema.DateTimeUtc,
  subject: SubjectSchema,
})

interface IssuedSession extends Schema.Schema.Type<typeof IssuedSessionSchema> {}

export const CurrentSessionSchema = Schema.Struct({
  expiresAt: Schema.DateTimeUtc,
  subject: SubjectSchema,
})

interface CurrentSession extends Schema.Schema.Type<typeof CurrentSessionSchema> {}

export type AuthenticatedIdentity = Readonly<CurrentSession & { sessionId: string; username: string }>

export class IdentityRuntime extends Context.Service<IdentityRuntime, {
  readonly signup: (credentials: Signup) => Effect.Effect<IssuedSession, AccountAlreadyExists | InvalidInviteToken | IdentityUnavailable>
  readonly close: (username: string) => Effect.Effect<void, IdentityUnavailable>
  readonly issueInvite: (requester: AuthenticatedIdentity) => Effect.Effect<IssuedInvite, Forbidden | IdentityUnavailable>
  readonly issuePasswordReset: (
    request: PasswordResetRequest,
    requester: AuthenticatedIdentity,
  ) => Effect.Effect<IssuedPasswordReset, Forbidden | AccountNotFound | IdentityUnavailable>
  readonly resetPassword: (request: PasswordReset) => Effect.Effect<void, InvalidPasswordResetToken | IdentityUnavailable>
  readonly login: (
    credentials: Credentials,
  ) => Effect.Effect<IssuedSession, Unauthenticated | IdentityUnavailable>
  readonly authenticate: (token: string) => Effect.Effect<AuthenticatedIdentity, Unauthenticated | IdentityUnavailable>
  readonly revoke: (sessionId: string) => Effect.Effect<void, IdentityUnavailable>
}>()("@effect-domains/IdentityRuntime") {}
