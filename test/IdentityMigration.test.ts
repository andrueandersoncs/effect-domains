import { mkdtempDisposableSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { expect, it } from "@effect/vitest"
import { Duration, Effect, Layer, Redacted, Schema, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { identifier } from "effect-domains/domain"
import { CredentialsSchema, IdentityRuntime, SubjectSchema } from "effect-domains/identity"
import { GroupActor, GroupRuntime } from "effect-domains/identity-groups"
import { Accounts, SqliteIdentity } from "effect-domains/sqlite-identity"
import { sqliteMigrationStore, SqliteMigrations } from "effect-domains/sqlite-migrations"
import { Table } from "effect-domains/table"

const PreviousSessions = Table.make({
  name: "identity_sessions",
  schema: Schema.Struct({
    id: identifier(Schema.String),
    token_digest: Schema.String,
    username: Schema.String,
    expires_at: Schema.Int,
    revoked_at: Schema.NullOr(Schema.Int),
  }),
  relations: {
    unique: [{ name: "identity_sessions_token_digest_key", fields: ["token_digest"] }],
    foreignKeys: [{
      name: "identity_sessions_username_fkey", fields: ["username"],
      references: Table.reference(Accounts, [Accounts.identifier]),
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
    const directory = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempDisposableSync(join(tmpdir(), "identity-upgrade-"))),
      (resource) => Effect.sync(() => resource.remove()),
    )
    const filename = join(directory.path, "identity.sqlite")
    const createPreviousVersion = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const store = sqliteMigrationStore(sql, SqliteMigrations.history(previousMigration))
      yield* store.prepare(previousTables.map(Table.snapshot))
      const hash = yield* Effect.promise(() => Bun.password.hash(Redacted.value(previousPassword), { algorithm: "argon2id" }))
      yield* sql`INSERT INTO identity_accounts (username, password_hash, subject_json, disabled)
        VALUES ('old-member', ${hash}, ${JSON.stringify({ userId: "old-member", tenantId: "acme", roles: ["reader"] })}, 0)`
      const digest = createHash("sha256").update(oldToken).digest("hex")
      yield* sql`INSERT INTO identity_sessions (id, token_digest, username, expires_at, revoked_at)
        VALUES ('old-session', ${digest}, 'old-member', ${Date.now() + 60 * 60 * 1000}, NULL)`
    })
    yield* Effect.provide(createPreviousVersion, SqliteClient.layer({ filename }))

    const dependencies = Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), BunServices.layer)
    const upgraded = pipe(SqliteIdentity.layer({
      application: "identity-upgrade-test",
      accounts: [{ username: "old-admin", subject: SubjectSchema.make({ userId: "old-admin", tenantId: "acme", roles: ["admin"] }) }],
      password: previousPassword,
      sessionLifetime: Duration.hours(8), filename,
    }), Layer.provide(dependencies))
    const check = (granted: boolean) => Effect.gen(function* () {
      const identity = yield* IdentityRuntime
      const groups = yield* GroupRuntime
      const oldSession = yield* identity.authenticate(oldToken)

      expect(oldSession.subject).toMatchObject({ userId: "old-member", tenantId: "acme" })

      const newSession = yield* identity.login(CredentialsSchema.make({ username: "old-member", password: previousPassword }))

      expect(newSession.subject).toMatchObject({ userId: "old-member", tenantId: "acme" })
      expect(yield* groups.check("old-member", "acme", "todos.review")).toBe(granted)
    })
    const grant = Effect.gen(function* () {
      const groups = yield* GroupRuntime
      const admin = GroupActor.make({ username: "old-admin", tenantId: "acme", admin: true })
      const group = yield* groups.create(admin, "upgrade-reviewers")

      yield* groups.addMember(admin, group.id, "old-member")
      yield* groups.grantGroup(admin, group.id, "todos.review")
    })
    yield* Effect.provide(check(false), upgraded)
    yield* Effect.provide(grant, upgraded)
    yield* Effect.provide(check(true), upgraded)
  }),
  Effect.scoped,
))
