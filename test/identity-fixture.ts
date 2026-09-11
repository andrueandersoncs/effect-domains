import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Redacted, pipe } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { CredentialsSchema, IdentityRuntime } from "effect-domains/identity"
import { SqliteIdentity } from "effect-domains/sqlite-identity"

const password = Redacted.make("test-password-only")
const identityDatabase = SqliteClient.layer({ filename: ":memory:" })
const dependencies = Layer.mergeAll(identityDatabase, BunServices.layer)

const sessionLifetime = Duration.hours(8)

export const TestIdentity = pipe(
  SqliteIdentity.layer({
    application: "effect-domains-test",
    accounts: [
      { username: "alice", subject: { userId: "alice", tenantId: "acme", roles: ["editor"] } },
      { username: "bob", subject: { userId: "bob", tenantId: "acme", roles: ["reader"] } },
      { username: "admin", subject: { userId: "admin", tenantId: "acme", roles: ["admin"] } },
      { username: "outsider", subject: { userId: "alice", tenantId: "other", roles: ["editor"] } },
    ],
    password,
    sessionLifetime,
    filename: ":memory:",
  }),
  Layer.provide(dependencies),
)

export const sessionFor = Effect.fn("IdentityTest.sessionFor")(function* (username: "alice" | "bob" | "admin" | "outsider") {
  const identity = yield* IdentityRuntime
  const credentials = CredentialsSchema.make({ username, password })
  const session = yield* identity.login(credentials)
  return { authorization: `Bearer ${Redacted.value(session.token)}` }
})
