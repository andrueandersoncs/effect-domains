import { mkdtempDisposableSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { expect, it } from "@effect/vitest"
import { Array, Duration, Effect, Layer, Redacted, Schema, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { identifier } from "effect-domains/domain"
import { CredentialsSchema, IdentityRuntime, SubjectSchema } from "effect-domains/identity"
import { GroupActor, GroupRuntime } from "effect-domains/identity-groups"
import { Accounts, SqliteIdentity } from "effect-domains/sqlite-identity"
import { sqliteMigrationStore, SqliteMigrations } from "effect-domains/sqlite-migrations"
import { Table } from "effect-domains/table"

const PreviousSessionSchema = Schema.Struct({
  id: identifier(Schema.String),
  token_digest: Schema.String,
  username: Schema.String,
  expires_at: Schema.Int,
  revoked_at: Schema.NullOr(Schema.Int),
})

interface PreviousSession extends Schema.Schema.Type<typeof PreviousSessionSchema> {}

const accountReference = Table.reference(Accounts, [Accounts.identifier])

const PreviousSessions = Table.make({
  name: "identity_sessions",
  schema: PreviousSessionSchema,
  relations: {
    unique: [{ name: "identity_sessions_token_digest_key", fields: ["token_digest"] }],
    foreignKeys: [{
      name: "identity_sessions_username_fkey", fields: ["username"],
      references: accountReference,
    }],
    indexes: [{ name: "identity_sessions_active", fields: ["token_digest", "expires_at"] }],
  },
})

const previousTables = [Accounts, PreviousSessions]
const previousMigration = SqliteMigrations.initial({ id: "001_initial", tables: previousTables })
const previousPassword = Redacted.make("old-account-password")
const oldToken = "previous-version-opaque-session"

it.effect("upgrades existing identity accounts and sessions without resetting credentials", () => pipe(
  Effect.gen(function* () {
    const acquireDirectory = Effect.sync(() => {
      const temporaryDirectory = tmpdir()
      const prefix = join(temporaryDirectory, "identity-upgrade-")

      return mkdtempDisposableSync(prefix)
    })

    const removeDirectory = (resource: Effect.Success<typeof acquireDirectory>) => Effect.sync(() => resource.remove())
    const directory = yield* Effect.acquireRelease(acquireDirectory, removeDirectory)
    const filename = join(directory.path, "identity.sqlite")

    const createPreviousVersion = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const history = SqliteMigrations.history(previousMigration)
      const store = sqliteMigrationStore(sql, history)
      const snapshots = Array.map(previousTables, Table.snapshot)
      const password = Redacted.value(previousPassword)

      yield* store.prepare(snapshots)

      const hash = yield* Effect.promise(() => Bun.password.hash(password, { algorithm: "argon2id" }))

      yield* sql`INSERT INTO identity_accounts (username, password_hash, subject_json, disabled)
        VALUES ('old-member', ${hash}, ${JSON.stringify({ userId: "old-member", tenantId: "acme", roles: ["reader"] })}, 0)`

      const digest = createHash("sha256").update(oldToken).digest("hex")

      yield* sql`INSERT INTO identity_sessions (id, token_digest, username, expires_at, revoked_at)
        VALUES ('old-session', ${digest}, 'old-member', ${Date.now() + 60 * 60 * 1000}, NULL)`
    })

    const previousDatabase = SqliteClient.layer({ filename })

    yield* Effect.provide(createPreviousVersion, previousDatabase)

    const inMemoryDatabase = SqliteClient.layer({ filename: ":memory:" })
    const dependencies = Layer.mergeAll(inMemoryDatabase, BunServices.layer)
    const adminSubject = SubjectSchema.make({ userId: "old-admin", tenantId: "acme", roles: ["admin"] })
    const sessionLifetime = Duration.hours(8)

    const upgraded = pipe(SqliteIdentity.layer({
      application: "identity-upgrade-test",
      accounts: [{ username: "old-admin", subject: adminSubject }],
      password: previousPassword,
      sessionLifetime, filename,
    }), Layer.provide(dependencies))

    const check = Effect.fn("IdentityMigration.check")(function* (granted: boolean) {
      const identity = yield* IdentityRuntime
      const groups = yield* GroupRuntime
      const oldSession = yield* identity.authenticate(oldToken)

      expect(oldSession.subject).toMatchObject({ userId: "old-member", tenantId: "acme" })

      const credentials = CredentialsSchema.make({ username: "old-member", password: previousPassword })
      const newSession = yield* identity.login(credentials)

      expect(newSession.subject).toMatchObject({ userId: "old-member", tenantId: "acme" })

      {
        const actual = yield* groups.check("old-member", "acme", "todos.review")
      
        expect(actual).toBe(granted)
      }
    })

    const grant = Effect.gen(function* () {
      const groups = yield* GroupRuntime
      const admin = GroupActor.make({ username: "old-admin", tenantId: "acme", admin: true })
      const group = yield* groups.create(admin, "upgrade-reviewers")

      yield* groups.addMember(admin, group.id, "old-member")
      yield* groups.grantGroup(admin, group.id, "todos.review")
    })

    const beforeGrant = check(false)
    const afterGrant = check(true)

    yield* Effect.provide(beforeGrant, upgraded)
    yield* Effect.provide(grant, upgraded)
    yield* Effect.provide(afterGrant, upgraded)
  }),
  Effect.scoped,
))
