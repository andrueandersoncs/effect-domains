import { createHash, randomBytes } from "node:crypto"
import { Array, Clock, Config, DateTime, Duration, Effect, FileSystem, Function, Layer, Option, Path, Redacted, Schema, Semaphore, Struct, pipe } from "effect"
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql"
import { Unauthenticated } from "effect-domains/authorization"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { CredentialsSchema, IdentityRuntime, IdentityUnavailable, IssuedSessionSchema, SubjectSchema } from "effect-domains/identity"
import { authenticateIdentity } from "effect-domains/identity-rpc"
import { privateSqlite } from "./databases.ts"
import initialMigration from "./identity-migrations/001_initial.json"
import { ExampleSubjectSchema } from "./subject.ts"

const accounts = [
  ["alice", ExampleSubjectSchema.make({ userId: "alice", tenantId: "acme", roles: ["editor"] })],
  ["bob", ExampleSubjectSchema.make({ userId: "bob", tenantId: "acme", roles: ["reader"] })],
  ["admin", ExampleSubjectSchema.make({ userId: "admin", tenantId: "acme", roles: ["admin"] })],
  ["outsider", ExampleSubjectSchema.make({ userId: "alice", tenantId: "other", roles: ["editor"] })],
] as const

const StoredSubjectSchema = Schema.fromJsonString(SubjectSchema)

const AccountRowSchema = Schema.Struct({
  username: Schema.String,
  password_hash: Schema.String,
  subject: StoredSubjectSchema,
})

const SessionRowSchema = Schema.Struct({
  id: Schema.String,
  expires_at: Schema.Int,
  subject: StoredSubjectSchema,
})

const SessionLookupSchema = Schema.Struct({ digest: Schema.String, now: Schema.Int })
const unavailable = () => IdentityUnavailable.make({})
const unauthenticated = () => Unauthenticated.make({})

const database = <A, R>(effect: Effect.Effect<A, SqlError.SqlError | Schema.SchemaError, R>) =>
  pipe(effect, Effect.mapError(unavailable))

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

const migrate = Effect.fn("ExampleIdentity.migrate")(function* (sql: SqlClient.SqlClient) {
  yield* database(sql`CREATE TABLE IF NOT EXISTS identity_migrations (version INTEGER NOT NULL PRIMARY KEY, applied_at INTEGER NOT NULL)`)
  const executeStatement = (statement: string) => sql`${sql.literal(statement)}`

  const transaction = Effect.gen(function* () {
    const applied = yield* sql`SELECT version FROM identity_migrations WHERE version = ${initialMigration.version}`
    if (Array.isReadonlyArrayNonEmpty(applied)) return
    yield* Effect.forEach(initialMigration.statements, executeStatement, { discard: true })
    const now = yield* Clock.currentTimeMillis
    yield* sql`INSERT INTO identity_migrations (version, applied_at) VALUES (${initialMigration.version}, ${now})`
  })

  yield* pipe(transaction, sql.withTransaction, database)
})

const seedAccounts = Effect.fn("ExampleIdentity.seedAccounts")(function* (sql: SqlClient.SqlClient, password: Redacted.Redacted<string>) {
  const seed = Effect.fn("ExampleIdentity.seedAccount")(function* ([username, subject]: typeof accounts[number]) {
    const existing = yield* database(sql`SELECT 1 FROM identity_accounts WHERE username = ${username} LIMIT 1`)
    if (Array.isReadonlyArrayNonEmpty(existing)) return
    const hash = yield* hashPassword(password)
    const subjectJson = yield* pipe(Schema.encodeEffect(StoredSubjectSchema)(subject), database)

    yield* database(sql`
      INSERT INTO identity_accounts ${sql.insert({ username, password_hash: hash, subject_json: subjectJson, disabled: 0 })}
      ON CONFLICT(username) DO NOTHING
    `)
  })

  yield* Effect.forEach(accounts, seed, { discard: true })
})

const identityRuntime = Effect.fn("ExampleIdentity.runtime")(function* (password: Redacted.Redacted<string>, sessionLifetime: Duration.Duration) {
  const sql = yield* SqlClient.SqlClient
  const clock = yield* Clock.Clock
  yield* migrate(sql)
  yield* seedAccounts(sql, password)
  const dummyPassword = yield* pipe(newToken(), Effect.map(Redacted.make))
  const dummyHash = yield* hashPassword(dummyPassword)
  const passwordVerifications = yield* Semaphore.make(2)

  const accountFor = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: AccountRowSchema,
    execute: (username) => sql`
      SELECT username, password_hash, subject_json AS subject FROM identity_accounts
      WHERE username = ${username} AND disabled = 0 LIMIT 1
    `,
  })

  const sessionFor = SqlSchema.findOneOption({
    Request: SessionLookupSchema,
    Result: SessionRowSchema,
    execute: ({ digest, now }) => sql`
      SELECT sessions.id, sessions.expires_at, accounts.subject_json AS subject
      FROM identity_sessions AS sessions
      INNER JOIN identity_accounts AS accounts ON accounts.username = sessions.username
      WHERE sessions.token_digest = ${digest} AND sessions.revoked_at IS NULL
        AND sessions.expires_at > ${now} AND accounts.disabled = 0
      LIMIT 1
    `,
  })

  const authenticate = Effect.fn("ExampleIdentity.authenticate")(function* (token: string) {
    const digest = yield* Effect.try({ try: () => tokenDigest(token), catch: unavailable })
    const now = yield* clock.currentTimeMillis
    const session = yield* pipe(sessionFor({ digest, now }), database, Effect.flatMap(Effect.fromOption(unauthenticated)))
    const expiresAt = yield* pipe(DateTime.make(session.expires_at), Effect.fromOption(unavailable))
    return { sessionId: session.id, expiresAt, subject: session.subject }
  })

  const login = Effect.fn("ExampleIdentity.login")(function* (credentials: typeof CredentialsSchema.Type) {
    const attempt = Effect.gen(function* () {
      const account = yield* pipe(accountFor(credentials.username), database)
      const hash = Option.match(account, { onNone: Function.constant(dummyHash), onSome: Struct.get("password_hash") })
      // Retain the permit because native Argon2 keeps running when its caller is interrupted.
      const valid = yield* pipe(verifyPassword(credentials.password, hash), Effect.uninterruptible)
      return { account, valid }
    })

    const result = yield* pipe(attempt, passwordVerifications.withPermitsIfAvailable(1), Effect.flatMap(Effect.fromOption(unavailable)))
    if (!result.valid) return yield* unauthenticated()
    const account = yield* pipe(result.account, Effect.fromOption(unauthenticated))
    const token = yield* newToken()
    const sessionId = yield* newSessionId()
    const digest = yield* Effect.try({ try: () => tokenDigest(token), catch: unavailable })
    const nowMillis = yield* clock.currentTimeMillis
    const now = yield* pipe(DateTime.make(nowMillis), Effect.fromOption(unavailable))
    const expiresAt = DateTime.addDuration(now, sessionLifetime)
    const expiresAtMillis = DateTime.toEpochMillis(expiresAt)

    yield* database(sql`INSERT INTO identity_sessions ${sql.insert({
      id: sessionId,
      token_digest: digest,
      username: account.username,
      expires_at: expiresAtMillis,
      revoked_at: null,
    })}`)

    const credential = Redacted.make(token)
    return IssuedSessionSchema.make({ token: credential, expiresAt, subject: account.subject })
  })

  return IdentityRuntime.of({
    login,
    authenticate,
    revoke: Effect.fn("ExampleIdentity.revoke")(function* (sessionId: string) {
      const now = yield* clock.currentTimeMillis
      yield* database(sql`UPDATE identity_sessions SET revoked_at = ${now} WHERE id = ${sessionId} AND revoked_at IS NULL`)
    }),
  })
})

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

const configuredIdentity = Effect.gen(function* () {
  const filename = yield* pipe(Config.string("EFFECT_DOMAINS_IDENTITY_DB"), Config.withDefault("data/identity.sqlite"))
  const configuredPassword = yield* Config.redacted("EFFECT_DOMAINS_DEMO_PASSWORD")
  const password = yield* Schema.decodeUnknownEffect(CredentialsSchema.fields.password)(configuredPassword)
  const defaultLifetime = Duration.hours(8)
  const sessionLifetime = yield* pipe(Config.duration("EFFECT_DOMAINS_SESSION_LIFETIME"), Config.withDefault(defaultLifetime))
  const validLifetime = Duration.isFinite(sessionLifetime) && Duration.isPositive(sessionLifetime)
  if (!validLifetime) return yield* unavailable()

  if (filename !== ":memory:") {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = path.dirname(filename)
    yield* fs.makeDirectory(directory, { recursive: true })
  }

  const runtime = identityRuntime(password, sessionLifetime)
  const sql = privateSqlite(filename)
  const store = pipe(Layer.effect(IdentityRuntime, runtime), Layer.provide(sql))

  return pipe(
    Layer.effect(AuthorizationRpc.Authenticator, authenticator),
    Layer.provideMerge(store),
  )
})

export const ExampleIdentity = Layer.unwrap(configuredIdentity)
