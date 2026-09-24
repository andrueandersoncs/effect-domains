import { Context, type DateTime, type Effect, Schema } from "effect"
import type { Unauthenticated } from "./authorization-model.ts"

const UsernameSchema = Schema.NonEmptyString.check(Schema.isMaxLength(320))
const PasswordSchema = Schema.NonEmptyString.check(Schema.isMaxLength(1024))

export class IdentityUnavailable extends Schema.TaggedError<IdentityUnavailable>()("IdentityUnavailable", {}) {}

export const SubjectSchema = Schema.Record(Schema.String, Schema.Unknown)

export const CredentialsSchema = Schema.Struct({
  username: UsernameSchema,
  password: Schema.Redacted(PasswordSchema),
})

interface Credentials extends Schema.Schema.Type<typeof CredentialsSchema> {}

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

type AuthenticatedIdentity = Readonly<{
  sessionId: string
  expiresAt: DateTime.Utc
  subject: typeof SubjectSchema.Type
}>

export class IdentityRuntime extends Context.Service<IdentityRuntime, {
  readonly login: (
    credentials: Schema.Schema.Type<typeof CredentialsSchema>,
  ) => Effect.Effect<Schema.Schema.Type<typeof IssuedSessionSchema>, Unauthenticated | IdentityUnavailable>
  readonly authenticate: (token: string) => Effect.Effect<AuthenticatedIdentity, Unauthenticated | IdentityUnavailable>
  readonly revoke: (sessionId: string) => Effect.Effect<void, IdentityUnavailable>
}>()("@effect-domains/IdentityRuntime") {}
