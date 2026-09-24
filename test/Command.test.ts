import { expect, it } from "@effect/vitest"
import { Effect, Equivalence, Schema, pipe } from "effect"
import { Headers } from "effect/unstable/http"
import { RpcTest } from "effect/unstable/rpc"
import { SqlClient } from "effect/unstable/sql"
import { Authorization } from "effect-domains/authorization"
import { Forbidden, Unauthenticated } from "effect-domains/authorization-model"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { Command } from "effect-domains/command"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"

class DeclaredFailure extends Schema.TaggedError<DeclaredFailure>()("DeclaredFailure", {}) {}
class CommandUnavailable extends Schema.TaggedError<CommandUnavailable>()("CommandUnavailable", {}) {}
class UnexpectedHandlerFailure extends Schema.TaggedError<UnexpectedHandlerFailure>()("UnexpectedHandlerFailure", {}) {}

const FailurePayloadSchema = Schema.Literals(["declared", "unexpected"])
const isDeclared = Equivalence.strictEqual<Schema.Schema.Type<typeof FailurePayloadSchema>>()

const makeFailures = (input: Schema.Schema.Type<typeof FailurePayloadSchema>) => {
  if (isDeclared(input, "declared")) return DeclaredFailure.make({})

  const unexpectedFailure = UnexpectedHandlerFailure.make({})

  return Effect.die(unexpectedFailure)
}

const failuresSpec = Command.define({
  name: "command.failures",
  payload: FailurePayloadSchema,
  success: Schema.String,
  errors: DeclaredFailure,
  unavailable: CommandUnavailable,
})

const failures = Command.implement(failuresSpec, makeFailures)


const SubjectSchema = Schema.Struct({ userId: Schema.String })

type Subject = Schema.Schema.Type<typeof SubjectSchema>

const authenticatedSubject = (userId: string) => SubjectSchema.make({ userId })


const subject = Authorization.subject(SubjectSchema)
const alicePredicate = subject.eq(subject.subject.userId, "alice")
const aliceOnly = subject.policy(alicePredicate)
const authenticatedUserId = (_input: void, authenticated: Subject) => Effect.succeed(authenticated.userId)

const protectedFamily = Command
  .family("family.", CommandUnavailable)
  .authorized(aliceOnly)

const familyMemberSpec = protectedFamily.define({
  name: "member",
  success: Schema.String,
})

const familyMember = Command.implement(familyMemberSpec, authenticatedUserId)

const protectedCommandSpec = Command.define({
  name: "command.protected",
  success: Schema.String,
  policy: aliceOnly,
  unavailable: CommandUnavailable,
})

const protectedCommand = Command.implement(protectedCommandSpec, authenticatedUserId)

const forbidden = Forbidden.make({})
const denyInside = (_input: void, _authenticated: Subject) => Effect.fail(forbidden)

// Nested denials stay Forbidden because the middleware already publishes that failure.
const deniedInsideSpec = Command.define({
  name: "command.deniedInside",
  success: Schema.String,
  policy: aliceOnly,
  unavailable: CommandUnavailable,
})

const deniedInside = Command.implement(deniedInsideSpec, denyInside)

const transactionalSpec = Command.define({
  name: "command.transactional",
  success: Schema.Void,
  errors: DeclaredFailure,
  transaction: true,
  unavailable: CommandUnavailable,
})

const transactional = Command.implement(
  transactionalSpec,
  Effect.fn("Command.test.transactional")(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* sql`INSERT INTO operation_events (value) VALUES (${"written"})`

    return yield* DeclaredFailure.make({})
  }),
)

const bundle = Command.bundle(failures, protectedCommand, familyMember, transactional, deniedInside)
const sqlite = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })

const authenticator = AuthorizationRpc.Authenticator.of({
  authenticate: (headers) => pipe(
    Headers.get(headers, "authorization"),
    Effect.fromOption(() => Unauthenticated.make({})),
    Effect.map(authenticatedSubject),
  ),
})

const runtime = <A, E, R>(effect: Effect.Effect<A, E, R>) => pipe(
  effect,
  Effect.provide(bundle.handlers),
  Effect.provide(AuthorizationRpc.layer),
  Effect.provideService(AuthorizationRpc.Authenticator, authenticator),
  Effect.provide(sqlite),
)

const replacementFailures = Effect.gen(function* () {
  const client = yield* RpcTest.makeClient(bundle.group)
  const declared = yield* pipe(client["command.failures"]("declared"), Effect.flip)

  expect(declared._tag).toBe("DeclaredFailure")

  const unavailable = yield* pipe(client["command.failures"]("unexpected"), Effect.flip)

  expect(unavailable._tag).toBe("CommandUnavailable")
})

it.effect("replaces undeclared handler failures while preserving declared errors", () => runtime(replacementFailures))

const subjectPolicy = Effect.gen(function* () {
  const client = yield* RpcTest.makeClient(bundle.group)
  const anonymous = yield* pipe(client["command.protected"](), Effect.flip)

  expect(anonymous._tag).toBe("Unauthenticated")

  const result = yield* client["command.protected"](undefined, { headers: { authorization: "alice" } })
  const familyResult = yield* client["family.member"](undefined, { headers: { authorization: "alice" } })

  expect(familyResult).toBe("alice")
  expect(result).toBe("alice")

  const denied = yield* pipe(client["command.deniedInside"](undefined, { headers: { authorization: "alice" } }), Effect.flip)

  expect(denied._tag).toBe("Forbidden")
})

it.effect("enforces subject policy, passes the typed subject, and keeps nested denials as Forbidden", () => runtime(subjectPolicy))

const transactionalRollback = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE operation_events (value TEXT NOT NULL)`

  const client = yield* RpcTest.makeClient(bundle.group)
  const failed = yield* pipe(client["command.transactional"](), Effect.flip)

  expect(failed._tag).toBe("DeclaredFailure")

  const rows = yield* sql`SELECT value FROM operation_events`

  expect(rows).toEqual([])
})

it.effect("rolls back transactional handler writes when the handler fails", () => runtime(transactionalRollback))
