import { createHash, randomBytes } from "node:crypto"
import { Array, Clock, Config, DateTime, Duration, Effect, Function, Layer, Option, Predicate, Redacted, Schema, Semaphore, Struct, pipe } from "effect"
import { SqlClient, SqlSchema } from "effect/unstable/sql"
import { Unauthenticated } from "./authorization-model.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
import { identifier } from "./domain.ts"
import { AccountAlreadyExists, CredentialsSchema, IdentityRuntime, IdentityUnavailable, IssuedSessionSchema, SignupSchema, SubjectSchema } from "./identity.ts"
import { database, unavailable } from "./identity-database.ts"
import { authenticateIdentity } from "./identity-authenticate.ts"
import { GroupRuntimeLive, GroupTables } from "./sqlite-identity-groups.ts"
import { SqliteBunRuntime } from "./sqlite-bun.ts"
import { sqliteMigrationStore, SqliteMigrations } from "./sqlite-migrations.ts"
import { identityCredentialOperations, PasswordResets, TenantInvites } from "./sqlite-identity-reset.ts"
import { Table } from "./table.ts"

const StoredSubjectSchema = Schema.fromJsonString(SubjectSchema)

const AccountsSchema = Schema.Struct({
  username: identifier(Schema.String),
  password_hash: Schema.String,
  subject_json: StoredSubjectSchema,
  disabled: Schema.Boolean,
})

interface Accounts extends Schema.Schema.Type<typeof AccountsSchema> {}

export const Accounts = Table.make({
  name: "identity_accounts",
  schema: AccountsSchema,
})

const SessionsSchema = Schema.Struct({
  id: identifier(Schema.String),
  token_digest: Schema.String,
  username: Schema.String,
  expires_at: Schema.Int,
  revoked_at: Schema.NullOr(Schema.Int),
})

interface Sessions extends Schema.Schema.Type<typeof SessionsSchema> {}

const AccountsUsernameReference = Table.reference(Accounts, [Accounts.identifier])

const Sessions = Table.make({
  name: "identity_sessions",
  schema: SessionsSchema,
  relations: {
    unique: [{ name: "identity_sessions_token_digest_key", fields: ["token_digest"] }],
    foreignKeys: [{
      name: "identity_sessions_username_fkey",
      fields: ["username"],
      references: AccountsUsernameReference,
    }],
    indexes: [{ name: "identity_sessions_active", fields: ["token_digest", "expires_at"] }],
  },
})

const InitialIdentityMigration = SqliteMigrations.initial({
  id: "001_initial",
  tables: [Accounts, Sessions],
})

const AddedIdentityTables = [PasswordResets, TenantInvites, ...GroupTables]
const IdentityTables = [Accounts, Sessions, ...AddedIdentityTables]
const identitySnapshot = SqliteMigrations.snapshot(IdentityTables)

const createIdentityTable = (table: (typeof AddedIdentityTables)[number]) =>
  SqliteMigrations.steps.CreateTable.make({ table: table.name })

const createdIdentityTables = Array.map(AddedIdentityTables, createIdentityTable)

const identityIndexNames = [
  { table: PasswordResets.name, name: "identity_password_resets_username_idx" },
  { table: TenantInvites.name, name: "identity_tenant_invites_issuer_idx" },
  { table: "identity_groups", name: "identity_groups_tenant" },
  { table: "identity_group_memberships", name: "identity_group_memberships_user" },
  { table: "identity_account_grants", name: "identity_account_grants_user" },
]

const createIdentityIndex = ({ table, name }: (typeof identityIndexNames)[number]) =>
  SqliteMigrations.steps.CreateIndex.make({ table, name })

const identityIndexes = Array.map(identityIndexNames, createIdentityIndex)

const IdentityExtension = SqliteMigrations.make({
  id: "002_account_groups_permissions",
  to: identitySnapshot,
  steps: [...createdIdentityTables, ...identityIndexes],
})

const IdentityMigrations = SqliteMigrations.history(InitialIdentityMigration, IdentityExtension)

const AccountRowSchema = Schema.Struct({
  username: Schema.String,
  password_hash: Schema.String,
  subject_json: StoredSubjectSchema,
})

interface AccountRow extends Schema.Schema.Type<typeof AccountRowSchema> {}

const NewAccountSchema = Schema.Struct({
  username: Schema.String,
  password_hash: Schema.String,
  subject_json: Schema.String,
})

interface NewAccount extends Schema.Schema.Type<typeof NewAccountSchema> {}

const InsertedAccountSchema = Schema.Struct({ username: Schema.String })

interface InsertedAccount extends Schema.Schema.Type<typeof InsertedAccountSchema> {}

const SessionRowSchema = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  expires_at: Schema.Int,
  subject_json: StoredSubjectSchema,
})

interface SessionRow extends Schema.Schema.Type<typeof SessionRowSchema> {}

const SessionLookupSchema = Schema.Struct({ digest: Schema.String, now: Schema.Int })

interface SessionLookup extends Schema.Schema.Type<typeof SessionLookupSchema> {}

interface IdentityAccount {
  readonly username: string
  readonly subject: typeof SubjectSchema.Type
}

interface SqliteIdentityOptionalOptions {
  readonly sessionLifetime: Duration.Duration
  readonly filename: string
}

interface SqliteIdentityOptions extends Partial<SqliteIdentityOptionalOptions> {
  readonly application: string
  readonly accounts: ReadonlyArray<IdentityAccount>
  readonly password: Config.Config<Redacted.Redacted<string>> | Redacted.Redacted<string>
}

const unauthenticated = () => Unauthenticated.make({})

const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex")
const newToken = Effect.try({ try: () => randomBytes(32).toString("base64url"), catch: unavailable })
const newSessionId = Effect.try({ try: () => randomBytes(16).toString("hex"), catch: unavailable })

const hashPassword = Effect.fn("SqliteIdentity.hashPassword")(function* (password: Redacted.Redacted<string>) {
  return yield* Effect.tryPromise({
    try: () => {
      const value = Redacted.value(password)

      return Bun.password.hash(value, { algorithm: "argon2id", memoryCost: 65536, timeCost: 2 })
    },
    catch: unavailable,
  })
})

const verifyPassword = Effect.fn("SqliteIdentity.verifyPassword")(function* (
  password: Redacted.Redacted<string>,
  hash: string,
) {
  return yield* Effect.tryPromise({
    try: () => {
      const value = Redacted.value(password)

      return Bun.password.verify(value, hash)
    },
    catch: unavailable,
  })
})

const prepare = Effect.fn("SqliteIdentity.prepare")(function* (sql: SqlClient.SqlClient) {
  const store = sqliteMigrationStore(sql, IdentityMigrations)
  const tables = Array.map(IdentityTables, Table.snapshot)

  yield* pipe(store.prepare(tables), database)
})

const seedAccounts = Effect.fn("SqliteIdentity.seedAccounts")(function* (
  sql: SqlClient.SqlClient,
  accounts: ReadonlyArray<IdentityAccount>,
  password: Redacted.Redacted<string>,
) {
  const seed = Effect.fn("SqliteIdentity.seedAccount")(function* (account: IdentityAccount) {
    const existing = yield* database(sql`SELECT 1 FROM ${sql(Accounts.name)} WHERE username = ${account.username} LIMIT 1`)

    if (existing.length > 0) return

    const password_hash = yield* hashPassword(password)
    const subject = Schema.encodeEffect(StoredSubjectSchema)(account.subject)
    const subject_json = yield* database(subject)

    yield* database(sql`
      INSERT INTO ${sql(Accounts.name)} ${sql.insert({
        username: account.username,
        password_hash,
        subject_json,
        disabled: 0,
      })}
      ON CONFLICT(username) DO NOTHING
    `)
  })

  yield* Effect.forEach(accounts, seed, { discard: true })
})

const makeRuntime = Effect.fn("SqliteIdentity.runtime")(function* (
  accounts: ReadonlyArray<IdentityAccount>,
  password: Redacted.Redacted<string>,
  sessionLifetime: Duration.Duration,
) {
  const sql = yield* SqlClient.SqlClient
  const clock = yield* Clock.Clock

  yield* prepare(sql)
  yield* seedAccounts(sql, accounts, password)

  const dummyPassword = yield* pipe(newToken, Effect.map(Redacted.make))
  const dummyHash = yield* hashPassword(dummyPassword)
  const credentialsRuntime = identityCredentialOperations(sql, clock, Accounts.name, Sessions.name, hashPassword)

  const insertAccount = SqlSchema.findOneOption({
    Request: NewAccountSchema,
    Result: InsertedAccountSchema,
    execute: (account) => sql`
      INSERT INTO ${sql(Accounts.name)} ${sql.insert({ ...account, disabled: 0 })}
      ON CONFLICT(username) DO NOTHING RETURNING username
    `,
  })

  const passwordVerifications = yield* Semaphore.make(2)

  const accountFor = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: AccountRowSchema,
    execute: (username) => sql`
      SELECT username, password_hash, subject_json FROM ${sql(Accounts.name)}
      WHERE username = ${username} AND disabled = 0 LIMIT 1
    `,
  })

  const sessionFor = SqlSchema.findOneOption({
    Request: SessionLookupSchema,
    Result: SessionRowSchema,
    execute: ({ digest, now }) => sql`
      SELECT sessions.id, sessions.username, sessions.expires_at, accounts.subject_json
      FROM ${sql(Sessions.name)} AS sessions
      INNER JOIN ${sql(Accounts.name)} AS accounts ON accounts.username = sessions.username
      WHERE sessions.token_digest = ${digest} AND sessions.revoked_at IS NULL
        AND sessions.expires_at > ${now} AND accounts.disabled = 0
      LIMIT 1
    `,
  })

  const authenticate = Effect.fn("SqliteIdentity.authenticate")(function* (token: string) {
    const digest = yield* Effect.try({ try: () => tokenDigest(token), catch: unavailable })
    const now = yield* clock.currentTimeMillis
    const session = yield* pipe(sessionFor({ digest, now }), database, Effect.flatMap(Effect.fromOption(unauthenticated)))
    const expiresAt = yield* pipe(DateTime.make(session.expires_at), Effect.fromOption(unavailable))

    return { sessionId: session.id, username: session.username, expiresAt, subject: session.subject_json }
  })

  const issueSession = Effect.fn("SqliteIdentity.issueSession")(function* (account: Pick<AccountRow, "username" | "subject_json">) {
    const token = yield* newToken
    const sessionId = yield* newSessionId
    const digest = yield* Effect.try({ try: () => tokenDigest(token), catch: unavailable })
    const nowMillis = yield* clock.currentTimeMillis
    const now = yield* pipe(DateTime.make(nowMillis), Effect.fromOption(unavailable))
    const expiresAt = DateTime.addDuration(now, sessionLifetime)
    const expires_at = DateTime.toEpochMillis(expiresAt)

    yield* database(sql`INSERT INTO ${sql(Sessions.name)} ${sql.insert({
      id: sessionId,
      token_digest: digest,
      username: account.username,
      expires_at,
      revoked_at: null,
    })}`)

    return IssuedSessionSchema.make({ token: Redacted.make(token), expiresAt, subject: account.subject_json })
  })

  const signup = Effect.fn("SqliteIdentity.signup")(function* (credentials: Schema.Schema.Type<typeof SignupSchema>) {
    const password_hash = yield* hashPassword(credentials.password)
    const invite = Option.fromNullishOr(credentials.inviteToken)

    const register = Effect.gen(function* () {
      const now = yield* clock.currentTimeMillis

      const tenantId = yield* Option.match(invite, {
        onNone: () => Effect.succeed(credentials.username),
        onSome: (token) => credentialsRuntime.consumeInvite(token, now),
      })

      const role = Option.isNone(invite) ? "admin" : "reader"
      const subject = SubjectSchema.make({ userId: credentials.username, tenantId, roles: [role] })
      const subject_json = yield* Schema.encodeEffect(StoredSubjectSchema)(subject)
      const inserted = yield* insertAccount({ username: credentials.username, password_hash, subject_json })

      if (Option.isNone(inserted)) return yield* AccountAlreadyExists.make({})

      return yield* issueSession({ username: credentials.username, subject_json: subject })
    })

    const committed = sql.withTransaction(register)

    return yield* pipe(committed, Effect.mapError((error) => {
      const accountConflict = Predicate.isTagged(error, "AccountAlreadyExists")
      const invalidInvite = Predicate.isTagged(error, "InvalidInviteToken")

      return accountConflict || invalidInvite ? error : unavailable()
    }))
  })

  const close = Effect.fn("SqliteIdentity.close")(function* (username: string) {
    const now = yield* clock.currentTimeMillis

    const disable = Effect.gen(function* () {
      yield* sql`UPDATE ${sql(Accounts.name)} SET disabled = 1 WHERE username = ${username} AND disabled = 0`

      yield* sql`UPDATE ${sql(Sessions.name)} SET revoked_at = ${now}
        WHERE username = ${username} AND revoked_at IS NULL`

      yield* sql`DELETE FROM ${sql(PasswordResets.name)} WHERE username = ${username}`
    })

    const committed = sql.withTransaction(disable)

    yield* database(committed)
  })

  const login = Effect.fn("SqliteIdentity.login")(function* (credentials: Schema.Schema.Type<typeof CredentialsSchema>) {
    const attempt = Effect.gen(function* () {
      const account = yield* pipe(accountFor(credentials.username), database)
      const hash = Option.match(account, { onNone: Function.constant(dummyHash), onSome: Struct.get("password_hash") })
      const valid = yield* pipe(verifyPassword(credentials.password, hash), Effect.uninterruptible)

      return { account, valid }
    })

    const resultOption = yield* passwordVerifications.withPermitsIfAvailable(1)(attempt)
    const result = yield* Effect.fromOption(resultOption, unavailable)

    if (!result.valid) return yield* unauthenticated()

    const account = yield* Effect.fromOption(result.account, unauthenticated)

    return yield* issueSession(account)
  })

  return IdentityRuntime.of({
    signup,
    close,
    issueInvite: credentialsRuntime.issueInvite,
    issuePasswordReset: credentialsRuntime.issuePasswordReset,
    resetPassword: credentialsRuntime.resetPassword,
    login,
    authenticate,
    revoke: Effect.fn("SqliteIdentity.revoke")(function* (sessionId: string) {
      const now = yield* clock.currentTimeMillis

      yield* database(sql`UPDATE ${sql(Sessions.name)} SET revoked_at = ${now} WHERE id = ${sessionId} AND revoked_at IS NULL`)
    }),
  })
})

const passwordValue = (password: SqliteIdentityOptions["password"]) =>
  Config.isConfig(password) ? password : Config.succeed(password)

const authenticator = Effect.gen(function* () {
  const runtime = yield* IdentityRuntime

  const authenticate = Effect.fn("SqliteIdentity.authenticateRequest")(function* (headers) {
    return yield* pipe(
      authenticateIdentity(headers),
      Effect.provideService(IdentityRuntime, runtime),
      Effect.map(Struct.get("subject")),
    )
  })

  return AuthorizationRpc.Authenticator.of({ authenticate })
})

const layer = (options: SqliteIdentityOptions) => {
  const lifetime = options.sessionLifetime ?? Duration.hours(8)
  const validLifetime = Duration.isFinite(lifetime) && Duration.isPositive(lifetime)

  if (!validLifetime) {
    const invalidLifetime = IdentityUnavailable.make({})
    const failedLifetime = Effect.fail(invalidLifetime)

    Effect.runSync(failedLifetime)
  }

  const privateClient = SqliteBunRuntime.privateClient({
    application: options.application,
    purpose: "identity",
    filename: options.filename,
  })

  const identityRuntime = Effect.gen(function* () {
    const password = yield* passwordValue(options.password)

    return yield* makeRuntime(options.accounts, password, lifetime)
  })

  const accountService = Layer.effect(IdentityRuntime, identityRuntime)
  const services = Layer.merge(accountService, GroupRuntimeLive)
  const runtime = pipe(services, Layer.provide(privateClient))
  const authorization = Layer.effect(AuthorizationRpc.Authenticator, authenticator)

  return pipe(
    authorization,
    Layer.provideMerge(runtime),
  )
}

export const SqliteIdentity = { layer }
