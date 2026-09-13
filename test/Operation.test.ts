import { expect, it } from "@effect/vitest"
import { Effect, Equivalence, Schema, pipe } from "effect"
import { Headers } from "effect/unstable/http"
import { RpcTest } from "effect/unstable/rpc"
import { SqlClient } from "effect/unstable/sql"
import { Authorization, Forbidden, Unauthenticated } from "effect-domains/authorization"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { Operation } from "effect-domains/operation"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"

class DeclaredFailure extends Schema.TaggedError<DeclaredFailure>()("DeclaredFailure", {}) {}
class OperationUnavailable extends Schema.TaggedError<OperationUnavailable>()("OperationUnavailable", {}) {}
class UnexpectedHandlerFailure extends Schema.TaggedError<UnexpectedHandlerFailure>()("UnexpectedHandlerFailure", {}) {}

const FailurePayloadSchema = Schema.Literals(["declared", "unexpected"])
const isDeclared = Equivalence.strictEqual<Schema.Schema.Type<typeof FailurePayloadSchema>>()

const makeFailures = (input: Schema.Schema.Type<typeof FailurePayloadSchema>) => {
  if (isDeclared(input, "declared")) return DeclaredFailure.make({})
  const unexpectedFailure = UnexpectedHandlerFailure.make({})
  return Effect.die(unexpectedFailure)
}

const failures = Operation.make({
  name: "operation.failures",
  payload: FailurePayloadSchema,
  success: Schema.String,
  errors: DeclaredFailure,
  unavailable: OperationUnavailable,
  handler: makeFailures,
})


const SubjectSchema = Schema.Struct({ userId: Schema.String })
type Subject = Schema.Schema.Type<typeof SubjectSchema>
const authenticatedSubject = (userId: string) => SubjectSchema.make({ userId })


const subject = Authorization.subject(SubjectSchema)
const alicePredicate = subject.eq(subject.subject.userId, "alice")
const aliceOnly = subject.policy(alicePredicate)
const authenticatedUserId = (_input: void, authenticated: Subject) => Effect.succeed(authenticated.userId)

const protectedFamily = Operation
  .family("family.", OperationUnavailable)
  .authorized(aliceOnly)

const familyMember = protectedFamily.make({
  name: "member",
  success: Schema.String,
  handler: authenticatedUserId,
})

const protectedOperation = Operation.make({
  name: "operation.protected",
  success: Schema.String,
  policy: aliceOnly,
  unavailable: OperationUnavailable,
  handler: authenticatedUserId,
})

const forbidden = Forbidden.make({})
const denyInside = (_input: void, _authenticated: Subject) => Effect.fail(forbidden)

// Nested denials stay Forbidden because the middleware already publishes that failure.
const deniedInside = Operation.make({
  name: "operation.deniedInside",
  success: Schema.String,
  policy: aliceOnly,
  unavailable: OperationUnavailable,
  handler: denyInside,
})

const transactional = Operation.make({
  name: "operation.transactional",
  success: Schema.Void,
  errors: DeclaredFailure,
  transaction: true,
  unavailable: OperationUnavailable,
  handler: Effect.fn("Operation.test.transactional")(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO operation_events (value) VALUES (${"written"})`
    return yield* DeclaredFailure.make({})
  }),
})

const bundle = Operation.bundle(failures, protectedOperation, familyMember, transactional, deniedInside)
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
  const declared = yield* pipe(client["operation.failures"]("declared"), Effect.flip)
  expect(declared._tag).toBe("DeclaredFailure")
  const unavailable = yield* pipe(client["operation.failures"]("unexpected"), Effect.flip)
  expect(unavailable._tag).toBe("OperationUnavailable")
})

it.effect("replaces undeclared handler failures while preserving declared errors", () => runtime(replacementFailures))

const subjectPolicy = Effect.gen(function* () {
  const client = yield* RpcTest.makeClient(bundle.group)
  const anonymous = yield* pipe(client["operation.protected"](), Effect.flip)
  expect(anonymous._tag).toBe("Unauthenticated")
  const result = yield* client["operation.protected"](undefined, { headers: { authorization: "alice" } })
  const familyResult = yield* client["family.member"](undefined, { headers: { authorization: "alice" } })
  expect(familyResult).toBe("alice")
  expect(result).toBe("alice")
  const denied = yield* pipe(client["operation.deniedInside"](undefined, { headers: { authorization: "alice" } }), Effect.flip)
  expect(denied._tag).toBe("Forbidden")
})

it.effect("enforces subject policy, passes the typed subject, and keeps nested denials as Forbidden", () => runtime(subjectPolicy))

const transactionalRollback = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE operation_events (value TEXT NOT NULL)`
  const client = yield* RpcTest.makeClient(bundle.group)
  const failed = yield* pipe(client["operation.transactional"](), Effect.flip)
  expect(failed._tag).toBe("DeclaredFailure")
  const rows = yield* sql`SELECT value FROM operation_events`
  expect(rows).toEqual([])
})

it.effect("rolls back transactional handler writes when the handler fails", () => runtime(transactionalRollback))
