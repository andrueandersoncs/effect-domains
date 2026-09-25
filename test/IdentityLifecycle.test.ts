import { expect, it } from "@effect/vitest"
import { Effect, Redacted, pipe } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { TestClock } from "effect/testing"
import { IdentityHandlers, IdentityRpcs } from "effect-domains/identity-rpc"
import { TestIdentity, sessionFor } from "./identity-fixture.ts"

const password = Redacted.make("test-password-only")
const replacement = Redacted.make("a-different-test-password")
const headersFor = (token: Redacted.Redacted<string>) => ({ authorization: `Bearer ${Redacted.value(token)}` })

it.effect("signup, invitation, reset and closure respect tenant and session boundaries", () => pipe(
  Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(IdentityRpcs)
    const admin = yield* sessionFor("admin")
    const alice = yield* sessionFor("alice")

    const isolated = yield* client["identity.signup"]({ username: "new-owner", password })
    expect(isolated.subject).toMatchObject({ userId: "new-owner", tenantId: "new-owner", roles: ["admin"] })
    expect(yield* client["identity.current"](undefined, { headers: headersFor(isolated.token) })).toMatchObject({ subject: { userId: "new-owner" } })
    const duplicate = yield* pipe(client["identity.signup"]({ username: "new-owner", password }), Effect.result)
    expect(duplicate).toMatchObject({ _tag: "Failure", failure: { _tag: "AccountAlreadyExists" } })

    const nonAdminInvite = yield* pipe(client["identity.issueInvite"](undefined, { headers: alice }), Effect.result)
    expect(nonAdminInvite).toMatchObject({ _tag: "Failure", failure: { _tag: "Forbidden" } })
    const invitation = yield* client["identity.issueInvite"](undefined, { headers: admin })
    const member = yield* client["identity.signup"]({ username: "new-member", password, inviteToken: invitation.token })
    expect(member.subject).toMatchObject({ userId: "new-member", tenantId: "acme", roles: ["reader"] })
    const replay = yield* pipe(client["identity.signup"]({ username: "replayed", password, inviteToken: invitation.token }), Effect.result)
    expect(replay).toMatchObject({ _tag: "Failure", failure: { _tag: "InvalidInviteToken" } })

    const crossTenantReset = yield* pipe(client["identity.issuePasswordReset"]({ username: "new-member" }, { headers: headersFor(isolated.token) }), Effect.result)
    expect(crossTenantReset).toMatchObject({ _tag: "Failure", failure: { _tag: "AccountNotFound" } })
    const nonAdminReset = yield* pipe(client["identity.issuePasswordReset"]({ username: "alice" }, { headers: alice }), Effect.result)
    expect(nonAdminReset).toMatchObject({ _tag: "Failure", failure: { _tag: "Forbidden" } })
    const reset = yield* client["identity.issuePasswordReset"]({ username: "new-member" }, { headers: admin })
    const secondMemberSession = yield* client["identity.login"]({ username: "new-member", password })
    yield* client["identity.resetPassword"]({ token: reset.token, password: replacement })
    const revokedSession = yield* pipe(client["identity.current"](undefined, { headers: headersFor(member.token) }), Effect.result)
    expect(revokedSession).toMatchObject({ _tag: "Failure", failure: { _tag: "Unauthenticated" } })
    const revokedSecondSession = yield* pipe(client["identity.current"](undefined, { headers: headersFor(secondMemberSession.token) }), Effect.result)
    expect(revokedSecondSession).toMatchObject({ _tag: "Failure", failure: { _tag: "Unauthenticated" } })
    const oldPassword = yield* pipe(client["identity.login"]({ username: "new-member", password }), Effect.result)
    expect(oldPassword).toMatchObject({ _tag: "Failure", failure: { _tag: "Unauthenticated" } })
    const reusedReset = yield* pipe(client["identity.resetPassword"]({ token: reset.token, password }), Effect.result)
    expect(reusedReset).toMatchObject({ _tag: "Failure", failure: { _tag: "InvalidPasswordResetToken" } })
    const renewed = yield* client["identity.login"]({ username: "new-member", password: replacement })
    const secondRenewedSession = yield* client["identity.login"]({ username: "new-member", password: replacement })

    yield* client["identity.close"](undefined, { headers: headersFor(renewed.token) })
    const afterClosure = yield* pipe(client["identity.current"](undefined, { headers: headersFor(renewed.token) }), Effect.result)
    expect(afterClosure).toMatchObject({ _tag: "Failure", failure: { _tag: "Unauthenticated" } })
    const secondAfterClosure = yield* pipe(client["identity.current"](undefined, { headers: headersFor(secondRenewedSession.token) }), Effect.result)
    expect(secondAfterClosure).toMatchObject({ _tag: "Failure", failure: { _tag: "Unauthenticated" } })
    const closedLogin = yield* pipe(client["identity.login"]({ username: "new-member", password: replacement }), Effect.result)
    expect(closedLogin).toMatchObject({ _tag: "Failure", failure: { _tag: "Unauthenticated" } })
    const closedSignup = yield* pipe(client["identity.signup"]({ username: "new-member", password }), Effect.result)
    expect(closedSignup).toMatchObject({ _tag: "Failure", failure: { _tag: "AccountAlreadyExists" } })

    const expiringInvite = yield* client["identity.issueInvite"](undefined, { headers: admin })
    const expiringReset = yield* client["identity.issuePasswordReset"]({ username: "new-owner" }, { headers: headersFor(isolated.token) })
    yield* TestClock.adjust("16 minutes")
    expect(yield* pipe(client["identity.signup"]({ username: "too-late", password, inviteToken: expiringInvite.token }), Effect.result))
      .toMatchObject({ _tag: "Failure", failure: { _tag: "InvalidInviteToken" } })
    expect(yield* pipe(client["identity.resetPassword"]({ token: expiringReset.token, password: replacement }), Effect.result))
      .toMatchObject({ _tag: "Failure", failure: { _tag: "InvalidPasswordResetToken" } })
  }),
  Effect.provide(IdentityHandlers),
  Effect.provide(TestIdentity),
), 30_000)
