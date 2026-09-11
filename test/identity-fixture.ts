import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Layer, Redacted, pipe } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { CredentialsSchema, IdentityRuntime } from "effect-domains/identity"

const provider = ConfigProvider.fromUnknown({
  EFFECT_DOMAINS_DEMO_PASSWORD: "test-password-only",
  EFFECT_DOMAINS_IDENTITY_DB: ":memory:",
  EFFECT_DOMAINS_SESSION_LIFETIME: "8 hours",
})

const configuration = ConfigProvider.layer(provider)
const identityDatabase = SqliteClient.layer({ filename: ":memory:" })
const dependencies = Layer.mergeAll(configuration, identityDatabase, BunServices.layer)
const password = Redacted.make("test-password-only")

export const TestIdentity = pipe(ExampleIdentity, Layer.provide(dependencies))

export const sessionFor = Effect.fn("IdentityTest.sessionFor")(function* (username: "alice" | "bob" | "admin" | "outsider") {
  const identity = yield* IdentityRuntime
  const credentials = CredentialsSchema.make({ username, password })
  const session = yield* identity.login(credentials)
  return { authorization: `Bearer ${Redacted.value(session.token)}` }
})
