import { expect, it } from "@effect/vitest"
import { Effect, Redacted, pipe } from "effect"
import { TestClock } from "effect/testing"
import { CredentialsSchema, IdentityRuntime } from "effect-domains/identity"
import { TestIdentity } from "./identity-fixture.ts"

const password = Redacted.make("test-password-only")

it.effect("identity rejects invalid, revoked, and expired issued sessions", () => pipe(
  Effect.gen(function* () {
    const identity = yield* IdentityRuntime
    const wrongPassword = Redacted.make("wrong-password")
    const invalidCredentials = CredentialsSchema.make({ username: "alice", password: wrongPassword })

    const invalid = yield* pipe(
      identity.login(invalidCredentials),
      Effect.result,
    )

    expect(invalid).toMatchObject({ _tag: "Failure", failure: { _tag: "Unauthenticated" } })

    const alice = CredentialsSchema.make({ username: "alice", password })
    const session = yield* identity.login(alice)
    const token = Redacted.value(session.token)
    const authenticated = yield* identity.authenticate(token)

    expect(authenticated.subject).toMatchObject({ userId: "alice", tenantId: "acme", roles: ["editor"] })
    yield* identity.revoke(authenticated.sessionId)

    const revoked = yield* pipe(identity.authenticate(token), Effect.result)

    expect(revoked).toMatchObject({ _tag: "Failure", failure: { _tag: "Unauthenticated" } })

    const bob = CredentialsSchema.make({ username: "bob", password })
    const expiring = yield* identity.login(bob)

    yield* TestClock.adjust("8 hours")

    const expiringToken = Redacted.value(expiring.token)
    const expiry = yield* pipe(identity.authenticate(expiringToken), Effect.result)

    expect(expiry).toMatchObject({ _tag: "Failure", failure: { _tag: "Unauthenticated" } })
  }),
  Effect.provide(TestIdentity),
))
