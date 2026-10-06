import { expect, it } from "@effect/vitest"
import { Effect, Redacted, pipe } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { Headers } from "effect/unstable/http"
import { TestClock } from "effect/testing"
import { IdentityHandlers, IdentityRpcs } from "effect-domains/identity-rpc"
import { SignupSchema } from "effect-domains/identity"
import { TestIdentity, sessionFor } from "./identity-fixture.ts"

const password = Redacted.make("test-password-only")
const replacement = Redacted.make("a-different-test-password")

const headersFor = (token: Redacted.Redacted<string>) => {
  const authorization = `Bearer ${Redacted.value(token)}`

  return Headers.fromInput({ authorization })
}

it.effect("signup, invitation, reset and closure respect tenant and session boundaries", () => pipe(
  Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(IdentityRpcs)

    const current = Effect.fn("IdentityLifecycle.current")(function* (headers: Headers.Headers) {
      return yield* client["identity.current"](undefined, { headers })
    })

    const signup = Effect.fn("IdentityLifecycle.signup")(function* (
      input: Omit<Parameters<typeof client["identity.signup"]>[0], "password">,
    ) {
      const credentials = SignupSchema.make({ ...input, password })

      return yield* client["identity.signup"](credentials)
    })

    const admin = yield* sessionFor("admin")
    const alice = yield* sessionFor("alice")
    const isolated = yield* signup({ username: "new-owner" })
    const isolatedHeaders = headersFor(isolated.token)

    expect(isolated.subject).toMatchObject({ userId: "new-owner", tenantId: "new-owner", roles: ["admin"] })

    {
      const actual = yield* current(isolatedHeaders)
    
      expect(actual).toMatchObject({ subject: { userId: "new-owner" } })
    }

    const duplicate = yield* pipe(signup({ username: "new-owner" }), Effect.result)

    expect(duplicate._tag).toBe("Failure")

    expect(duplicate).toHaveProperty("failure._tag", "AccountAlreadyExists")

    const nonAdminInvite = yield* pipe(client["identity.issueInvite"](undefined, { headers: alice }), Effect.result)

    expect(nonAdminInvite._tag).toBe("Failure")

    expect(nonAdminInvite).toHaveProperty("failure._tag", "Forbidden")

    const invitation = yield* client["identity.issueInvite"](undefined, { headers: admin })
    const member = yield* signup({ username: "new-member", inviteToken: invitation.token })
    const memberHeaders = headersFor(member.token)

    expect(member.subject).toMatchObject({ userId: "new-member", tenantId: "acme", roles: ["reader"] })

    const replay = yield* pipe(signup({ username: "replayed", inviteToken: invitation.token }), Effect.result)

    expect(replay._tag).toBe("Failure")

    expect(replay).toHaveProperty("failure._tag", "InvalidInviteToken")

    const crossTenantReset = yield* pipe(client["identity.issuePasswordReset"]({ username: "new-member" }, { headers: isolatedHeaders }), Effect.result)

    expect(crossTenantReset._tag).toBe("Failure")

    expect(crossTenantReset).toHaveProperty("failure._tag", "AccountNotFound")

    const nonAdminReset = yield* pipe(client["identity.issuePasswordReset"]({ username: "alice" }, { headers: alice }), Effect.result)

    expect(nonAdminReset._tag).toBe("Failure")

    expect(nonAdminReset).toHaveProperty("failure._tag", "Forbidden")

    const reset = yield* client["identity.issuePasswordReset"]({ username: "new-member" }, { headers: admin })
    const secondMemberSession = yield* client["identity.login"]({ username: "new-member", password })
    const secondMemberHeaders = headersFor(secondMemberSession.token)

    yield* client["identity.resetPassword"]({ token: reset.token, password: replacement })

    const revokedSession = yield* pipe(current(memberHeaders), Effect.result)

    expect(revokedSession._tag).toBe("Failure")

    expect(revokedSession).toHaveProperty("failure._tag", "Unauthenticated")

    const revokedSecondSession = yield* pipe(current(secondMemberHeaders), Effect.result)

    expect(revokedSecondSession._tag).toBe("Failure")

    expect(revokedSecondSession).toHaveProperty("failure._tag", "Unauthenticated")

    const oldPassword = yield* pipe(client["identity.login"]({ username: "new-member", password }), Effect.result)

    expect(oldPassword._tag).toBe("Failure")

    expect(oldPassword).toHaveProperty("failure._tag", "Unauthenticated")

    const reusedReset = yield* pipe(client["identity.resetPassword"]({ token: reset.token, password }), Effect.result)

    expect(reusedReset._tag).toBe("Failure")

    expect(reusedReset).toHaveProperty("failure._tag", "InvalidPasswordResetToken")

    const renewed = yield* client["identity.login"]({ username: "new-member", password: replacement })
    const secondRenewedSession = yield* client["identity.login"]({ username: "new-member", password: replacement })
    const renewedHeaders = headersFor(renewed.token)
    const secondRenewedHeaders = headersFor(secondRenewedSession.token)

    yield* client["identity.close"](undefined, { headers: renewedHeaders })

    const afterClosure = yield* pipe(current(renewedHeaders), Effect.result)

    expect(afterClosure._tag).toBe("Failure")

    expect(afterClosure).toHaveProperty("failure._tag", "Unauthenticated")

    const secondAfterClosure = yield* pipe(current(secondRenewedHeaders), Effect.result)

    expect(secondAfterClosure._tag).toBe("Failure")

    expect(secondAfterClosure).toHaveProperty("failure._tag", "Unauthenticated")

    const closedLogin = yield* pipe(client["identity.login"]({ username: "new-member", password: replacement }), Effect.result)

    expect(closedLogin._tag).toBe("Failure")

    expect(closedLogin).toHaveProperty("failure._tag", "Unauthenticated")

    const closedSignup = yield* pipe(signup({ username: "new-member" }), Effect.result)

    expect(closedSignup._tag).toBe("Failure")

    expect(closedSignup).toHaveProperty("failure._tag", "AccountAlreadyExists")

    const expiringInvite = yield* client["identity.issueInvite"](undefined, { headers: admin })
    const expiringReset = yield* client["identity.issuePasswordReset"]({ username: "new-owner" }, { headers: isolatedHeaders })

    yield* TestClock.adjust("16 minutes")

    {
      const failureResult = yield* pipe(signup({ username: "too-late", inviteToken: expiringInvite.token }), Effect.result)
    
      expect(failureResult._tag).toBe("Failure")
    
      expect(failureResult).toHaveProperty("failure._tag", "InvalidInviteToken")
    }

    {
      const failureResult = yield* pipe(client["identity.resetPassword"]({ token: expiringReset.token, password: replacement }), Effect.result)
    
      expect(failureResult._tag).toBe("Failure")
    
      expect(failureResult).toHaveProperty("failure._tag", "InvalidPasswordResetToken")
    }
  }),
  Effect.provide(IdentityHandlers),
  Effect.provide(TestIdentity),
), 30_000)
