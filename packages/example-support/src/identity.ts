import { Config, Duration, Effect, Layer, pipe } from "effect"
import { SqliteIdentity } from "effect-domains/sqlite-identity"

const accounts = [
  { username: "alice", subject: { userId: "alice", tenantId: "acme", roles: ["editor"] } },
  { username: "bob", subject: { userId: "bob", tenantId: "acme", roles: ["reader"] } },
  { username: "admin", subject: { userId: "admin", tenantId: "acme", roles: ["admin"] } },
  { username: "outsider", subject: { userId: "outsider", tenantId: "other", roles: ["editor"] } },
] as const

const defaultSessionLifetime = Duration.hours(8)

const sessionLifetime = pipe(
  Config.duration("EFFECT_DOMAINS_SESSION_LIFETIME"),
  Config.withDefault(defaultSessionLifetime),
)

const password = Config.redacted("EFFECT_DOMAINS_DEMO_PASSWORD")

const makeIdentityLayer = Effect.fn("ExampleIdentity.makeLayer")(function* (application: string) {
  const lifetime = yield* sessionLifetime

  return SqliteIdentity.layer({
    application,
    accounts,
    password,
    sessionLifetime: lifetime,
  })
})

const layer = (application: string) => pipe(makeIdentityLayer(application), Layer.unwrap)

export const ExampleIdentity = { layer }
