import { createHash, randomBytes } from "node:crypto"
import { Clock, Config, DateTime, Duration, Effect, Function, Layer, Option, Redacted, Schema, Semaphore, Struct, pipe } from "effect"
import { SqlClient, SqlSchema } from "effect/unstable/sql"
import { Unauthenticated } from "./authorization.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
import { identifier } from "./domain.ts"
import { CredentialsSchema, IdentityRuntime, IdentityUnavailable, IssuedSessionSchema, SubjectSchema } from "./identity.ts"
import { authenticateIdentity } from "./identity-rpc.ts"
import { SqliteBunRuntime } from "./sqlite-bun.ts"
import { sqliteMigrationStore, SqliteMigrations } from "./sqlite-migrations.ts"
import { Table } from "./table.ts"

const StoredSubjectSchema = Schema.fromJsonString(SubjectSchema)

const AccountsSchema = Schema.Struct({
  username: identifier(Schema.String),
  password_hash: Schema.String,
  subject_json: StoredSubjectSchema,
  disabled: Schema.Boolean,
})

const Accounts = Table.make({
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

const IdentityMigrations = SqliteMigrations.history(InitialIdentityMigration)

const AccountRowSchema = Schema.Struct({
  username: Schema.String,
  password_hash: Schema.String,
  subject_json: StoredSubjectSchema,
})

const SessionRowSchema = Schema.Struct({
  id: Schema.String,
  expires_at: Schema.Int,
  subject_json: StoredSubjectSchema,
})

const SessionLookupSchema = Schema.Struct({ digest: Schema.String, now: Schema.Int })

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

const unavailable = () => IdentityUnavailable.make({})
const unauthenticated = () => Unauthenticated.make({})

const database = Effect.fn("SqliteIdentity.database")(<A, E, R>(effect: Effect.Effect<A, E, R>) =>
  pipe(effect, Effect.mapError(unavailable)))

const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex")
const newToken = () => Effect.try({ try: () => randomBytes(32).toString("base64url"), catch: unavailable })
const newSessionId = () => Effect.try({ try: () => randomBytes(16).toString("hex"), catch: unavailable })

const hashPassword = (password: Redacted.Redacted<string>) => Effect.tryPromise({
  try: () => {
    const value = Redacted.value(password)

    return Bun.password.hash(value, { algorithm: "argon2id", memoryCost: 65536, timeCost: 2 })
  },
  catch: unavailable,
})

const verifyPassword = (password: Redacted.Redacted<string>, hash: string) => Effect.tryPromise({
  try: () => {
    const value = Redacted.value(password)

    return Bun.password.verify(value, hash)
  },
  catch: unavailable,
})

const prepare = Effect.fn("SqliteIdentity.prepare")(function* (sql: SqlClient.SqlClient) {
  const store = sqliteMigrationStore(sql, IdentityMigrations)
  const tables = [Table.snapshot(Accounts), Table.snapshot(Sessions)]

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

  const dummyPassword = yield* pipe(newToken(), Effect.map(Redacted.make))
  const dummyHash = yield* hashPassword(dummyPassword)
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
      SELECT sessions.id, sessions.expires_at, accounts.subject_json
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

    return { sessionId: session.id, expiresAt, subject: session.subject_json }
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
    const token = yield* newToken()
    const sessionId = yield* newSessionId()
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

  return IdentityRuntime.of({
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

  return AuthorizationRpc.Authenticator.of({
    authenticate: (headers) => pipe(
      authenticateIdentity(headers),
      Effect.provideService(IdentityRuntime, runtime),
      Effect.map(Struct.get("subject")),
    ),
  })
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

  const runtime = pipe(
    Layer.effect(IdentityRuntime, identityRuntime),
    Layer.provide(privateClient),
  )

  const authorization = Layer.effect(AuthorizationRpc.Authenticator, authenticator)

  return pipe(
    authorization,
    Layer.provideMerge(runtime),
  )
}

export const SqliteIdentity = { layer }
