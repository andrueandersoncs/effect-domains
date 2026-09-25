import { createHash, randomBytes } from "node:crypto"
import { Array, Clock, Effect, Equivalence, Option, Predicate, Redacted, Schema, pipe } from "effect"
import { SqlClient, SqlSchema, Statement } from "effect/unstable/sql"
import { Forbidden } from "../../authorization/model.ts"
import { identifier } from "../../domain.ts"
import { AccountUsernameRowSchema, type AccountUsernameRow, database, unavailable } from "../database.ts"

import {
  AccountNotFound, type AuthenticatedIdentity, IdentityUnavailable, InvalidInviteToken,
  InvalidPasswordResetToken, IssuedInviteSchema, IssuedPasswordResetSchema,
  type PasswordResetRequestSchema, type PasswordResetSchema, SubjectSchema,
} from "../index.ts"

import { Table } from "../../table/index.ts"

const ResetTableSchema = Schema.Struct({
  token_digest: identifier(Schema.String),
  username: Schema.String,
  expires_at: Schema.Int,
})

interface ResetTable extends Schema.Schema.Type<typeof ResetTableSchema> {}

export const PasswordResets = Table.make({
  name: "identity_password_resets",
  schema: ResetTableSchema,
  relations: { indexes: [{ name: "identity_password_resets_username_idx", fields: ["username"] }] },
})

const InviteTableSchema = Schema.Struct({
  token_digest: identifier(Schema.String),
  tenant_id: Schema.String,
  issuer_username: Schema.String,
  expires_at: Schema.Int,
})

interface InviteTable extends Schema.Schema.Type<typeof InviteTableSchema> {}

export const TenantInvites = Table.make({
  name: "identity_tenant_invites",
  schema: InviteTableSchema,
  relations: { indexes: [{ name: "identity_tenant_invites_issuer_idx", fields: ["issuer_username"] }] },
})

const StoredSubjectSchema = Schema.fromJsonString(SubjectSchema)
const AccountSubjectSchema = Schema.Struct({ subject_json: StoredSubjectSchema })
const InviteTenantSchema = Schema.Struct({ tenant_id: Schema.String })
const RequesterSchema = Schema.Struct({ sessionId: Schema.String, username: Schema.String, now: Schema.Int })
const DigestTimeSchema = Schema.Struct({ digest: Schema.String, now: Schema.Int })
const TokenDigestSchema = Schema.Struct({ token_digest: Schema.String })
const AdminSubjectSchema = Schema.Struct({ roles: Schema.Array(Schema.Unknown), tenantId: Schema.String })

interface AccountSubject extends Schema.Schema.Type<typeof AccountSubjectSchema> {}
interface InviteTenant extends Schema.Schema.Type<typeof InviteTenantSchema> {}
interface Requester extends Schema.Schema.Type<typeof RequesterSchema> {}
interface DigestTime extends Schema.Schema.Type<typeof DigestTimeSchema> {}
interface TokenDigest extends Schema.Schema.Type<typeof TokenDigestSchema> {}
interface AdminSubject extends Schema.Schema.Type<typeof AdminSubjectSchema> {}

const preserveInviteError = (error: unknown) =>
  Predicate.isTagged(error, "Forbidden") ? Forbidden.make({}) : unavailable()

const preserveIssueResetError = (error: unknown) => {
  if (Predicate.isTagged(error, "Forbidden")) return Forbidden.make({})

  return Predicate.isTagged(error, "AccountNotFound") ? AccountNotFound.make({}) : unavailable()
}

const preserveInvalidResetError = (error: unknown) =>
  Predicate.isTagged(error, "InvalidPasswordResetToken") ? InvalidPasswordResetToken.make({}) : unavailable()

const RESET_LIFETIME_MILLIS = 15 * 60 * 1000
const invalidToken = () => InvalidPasswordResetToken.make({})
const digestToken = (token: string) => createHash("sha256").update(token).digest("hex")

export const identityCredentialOperations = (
  sql: SqlClient.SqlClient,
  clock: Clock.Clock,
  accountsTable: string,
  sessionsTable: string,
  hashPassword: (password: Redacted.Redacted<string>) => Effect.Effect<string, IdentityUnavailable>,
) => {
  const subjectFor = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: AccountSubjectSchema,
    execute: (username) => sql`
      SELECT subject_json FROM ${sql(accountsTable)} WHERE username = ${username} AND disabled = 0 LIMIT 1
    `,
  })

  const requesterFor = SqlSchema.findOneOption({
    Request: RequesterSchema,
    Result: AccountSubjectSchema,
    execute: ({ sessionId, username, now }) => sql`
      SELECT accounts.subject_json FROM ${sql(sessionsTable)} AS sessions
      INNER JOIN ${sql(accountsTable)} AS accounts ON accounts.username = sessions.username
      WHERE sessions.id = ${sessionId} AND sessions.username = ${username}
        AND sessions.revoked_at IS NULL AND sessions.expires_at > ${now} AND accounts.disabled = 0
      LIMIT 1
    `,
  })

  const adminTenant = Effect.fn("SqliteIdentity.adminTenant")(function* (requester: AuthenticatedIdentity, now: number) {
    const requesterAccount = yield* requesterFor({ sessionId: requester.sessionId, username: requester.username, now })
    const principal = yield* Effect.fromOption(requesterAccount, () => Forbidden.make({}))
    const parsed = Schema.decodeUnknownOption(AdminSubjectSchema)(principal.subject_json)
    const subject = yield* Effect.fromOption(parsed, () => Forbidden.make({}))
    const isAdmin = Array.contains(subject.roles, "admin")

    if (!isAdmin) return yield* Forbidden.make({})

    return subject.tenantId
  })

  const findToken = <Result extends Schema.Constraint>(
    Result: Result,
    execute: (request: DigestTime) => Statement.Statement<object>,
  ) => SqlSchema.findOneOption({ Request: DigestTimeSchema, Result, execute })

  const activeToken = (table: string, ownerColumn: string, { digest, now }: DigestTime) => sql`
    token_digest = ${digest} AND expires_at > ${now}
      AND EXISTS (SELECT 1 FROM ${sql(accountsTable)}
        WHERE username = ${sql(table)}.${sql(ownerColumn)} AND disabled = 0)
  `

  const deleteEligibleToken = (table: string, ownerColumn: string, returning: string) => (request: DigestTime) => sql`
    DELETE FROM ${sql(table)}
    WHERE ${activeToken(table, ownerColumn, request)}
    RETURNING ${sql(returning)}
  `

  const inviteFor = findToken(
    InviteTenantSchema,
    deleteEligibleToken(TenantInvites.name, "issuer_username", "tenant_id"),
  )

  const consumeInvite = Effect.fn("SqliteIdentity.consumeInvite")(function* (token: Redacted.Redacted<string>, now: number) {
    // Run inside the caller's transaction because failed account creation must restore the invitation.
    const rawToken = Redacted.value(token)
    const digest = yield* Effect.try({ try: () => digestToken(rawToken), catch: unavailable })
    const lookup = inviteFor({ digest, now })
    const invite = yield* database(lookup)
    const active = yield* Effect.fromOption(invite, () => InvalidInviteToken.make({}))

    return active.tenant_id
  })

  const issueInvite = Effect.fn("SqliteIdentity.issueInvite")(function* (requester: AuthenticatedIdentity) {
    const token = yield* Effect.try({ try: () => randomBytes(32).toString("base64url"), catch: unavailable })
    const digest = yield* Effect.try({ try: () => digestToken(token), catch: unavailable })

    const insertion = Effect.gen(function* () {
      const now = yield* clock.currentTimeMillis
      const tenant_id = yield* adminTenant(requester, now)

      yield* sql`INSERT INTO ${sql(TenantInvites.name)} ${sql.insert({
        token_digest: digest,
        tenant_id,
        issuer_username: requester.username,
        expires_at: now + RESET_LIFETIME_MILLIS,
      })}`
    })

    const transaction = sql.withTransaction(insertion)

    yield* pipe(
      transaction,
      Effect.mapError(preserveInviteError),
    )

    return IssuedInviteSchema.make({ token: Redacted.make(token) })
  })

  const consume = findToken(
    AccountUsernameRowSchema,
    deleteEligibleToken(PasswordResets.name, "username", "username"),
  )

  const selectReset = (request: DigestTime) => sql`
    SELECT token_digest FROM ${sql(PasswordResets.name)}
    WHERE ${activeToken(PasswordResets.name, "username", request)}
    LIMIT 1
  `

  const resetExists = findToken(TokenDigestSchema, selectReset)

  const issuePasswordReset = Effect.fn("SqliteIdentity.issuePasswordReset")(function* (
    request: Schema.Schema.Type<typeof PasswordResetRequestSchema>,
    requester: AuthenticatedIdentity,
  ) {
    const token = yield* Effect.try({ try: () => randomBytes(32).toString("base64url"), catch: unavailable })
    const digest = yield* Effect.try({ try: () => digestToken(token), catch: unavailable })

    const insertion = Effect.gen(function* () {
      const now = yield* clock.currentTimeMillis
      const tenantId = yield* adminTenant(requester, now)
      const account = yield* subjectFor(request.username)
      const target = yield* Effect.fromOption(account, () => AccountNotFound.make({}))
      const parsedTenant = Schema.decodeUnknownOption(Schema.String)(target.subject_json.tenantId)
      const targetTenant = yield* Effect.fromOption(parsedTenant, () => AccountNotFound.make({}))
      const sameTenant = Equivalence.strictEqual<string>()(targetTenant, tenantId)

      if (!sameTenant) return yield* AccountNotFound.make({})

      // Issuing another reset invalidates unredeemed credentials because only the latest token should remain valid.
      yield* sql`DELETE FROM ${sql(PasswordResets.name)} WHERE username = ${request.username}`

      yield* sql`INSERT INTO ${sql(PasswordResets.name)} ${sql.insert({
        token_digest: digest,
        username: request.username,
        expires_at: now + RESET_LIFETIME_MILLIS,
      })}`
    })

    const transaction = sql.withTransaction(insertion)

    yield* pipe(
      transaction,
      Effect.mapError(preserveIssueResetError),
    )

    return IssuedPasswordResetSchema.make({ token: Redacted.make(token) })
  })

  const resetPassword = Effect.fn("SqliteIdentity.resetPassword")(function* (
    request: Schema.Schema.Type<typeof PasswordResetSchema>,
  ) {
    const token = Redacted.value(request.token)
    const digest = yield* Effect.try({ try: () => digestToken(token), catch: unavailable })
    const now = yield* clock.currentTimeMillis
    const lookup = resetExists({ digest, now })
    const eligible = yield* database(lookup)

    if (Option.isNone(eligible)) return yield* invalidToken()

    // Hash before consuming the credential because a hashing failure must leave it valid.
    const password_hash = yield* hashPassword(request.password)

    const update = Effect.gen(function* () {
      const now = yield* clock.currentTimeMillis
      const account = yield* consume({ digest, now })
      const active: AccountUsernameRow = yield* Effect.fromOption(account, invalidToken)

      yield* sql`UPDATE ${sql(accountsTable)} SET password_hash = ${password_hash}
        WHERE username = ${active.username} AND disabled = 0`

      yield* sql`UPDATE ${sql(sessionsTable)} SET revoked_at = ${now}
        WHERE username = ${active.username} AND revoked_at IS NULL`

      yield* sql`DELETE FROM ${sql(PasswordResets.name)} WHERE username = ${active.username}`
    })

    const transaction = sql.withTransaction(update)

    yield* pipe(
      transaction,
      Effect.mapError(preserveInvalidResetError),
    )
  })

  return { issueInvite, consumeInvite, issuePasswordReset, resetPassword }
}
