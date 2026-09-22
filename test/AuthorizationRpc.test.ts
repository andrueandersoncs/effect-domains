import { expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Record, Result, Schema, Struct, pipe } from "effect"
import { Headers } from "effect/unstable/http"
import { Rpc, RpcGroup, RpcTest } from "effect/unstable/rpc"
import { SqlClient } from "effect/unstable/sql"
import { Authorization, AuthorizationSubject, Unauthenticated } from "effect-domains/authorization"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { identifier } from "effect-domains/domain"
import { Resource } from "effect-domains/resource"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { prepareTables } from "./prepare-tables.ts"

const NoteReaderSchema = Schema.Struct({ userId: Schema.String })

interface NoteReader extends Schema.Schema.Type<typeof NoteReaderSchema> {}

const PrivateNoteSchema = Schema.Struct({ id: identifier(Schema.String), ownerId: Schema.String, text: Schema.String })

interface PrivateNote extends Schema.Schema.Type<typeof PrivateNoteSchema> {}

const p = Authorization.for({ resource: PrivateNoteSchema, subject: NoteReaderSchema })
const owned = p.eq(p.row.ownerId, p.subject.userId)
const candidateOwned = p.eq(p.next.ownerId, p.subject.userId)
const unrestrictedScope = p.all()
const policy = p.policy({ scope: unrestrictedScope, allow: { read: owned, create: candidateOwned } })

const noteCreateSources = { ownerId: Resource.fromSubject(p.subject.userId) }

const noteCapabilities = [
  Resource.get(),
  Resource.create({ sources: noteCreateSources }),
]

const Notes = Resource.define({
  name: "private_notes",
  schema: PrivateNoteSchema,
  authorization: policy,
  capabilities: noteCapabilities,
})

const notesTable = Resource.table(Notes)

const NotesRuntime = Resource.compile(Notes)

const SessionsSchema = Schema.Record(Schema.String, NoteReaderSchema)

interface Sessions extends Schema.Schema.Type<typeof SessionsSchema> {}

const sessions = SessionsSchema.make({ "Bearer alice-session": { userId: "alice" }, "Bearer bob-session": { userId: "bob" } })
const sessionFor = (token: string) => Record.get(sessions, token)

const authenticate = Effect.fn("AuthorizationRpc.testAuthenticate")(function* (headers: Headers.Headers) {
  const subject = pipe(Headers.get(headers, "authorization"), Option.flatMap(sessionFor))

  return yield* Effect.fromOption(subject, () => Unauthenticated.make({}))
})

const authenticator = AuthorizationRpc.Authenticator.of({ authenticate })
const sqlite = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })
const aliceHeaders = { authorization: "Bearer alice-session" }
const bobHeaders = { authorization: "Bearer bob-session" }

it.effect("RPC authentication overrides captured identity and isolates concurrent requests", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([notesTable])

    const sql = yield* SqlClient.SqlClient

    yield* sql`INSERT INTO private_notes (id, ownerId, text) VALUES ('alice-note', 'alice', 'alice secret'), ('bob-note', 'bob', 'bob secret')`

    const client = yield* RpcTest.makeClient(NotesRuntime.group)

    const forgedPayload = yield* pipe(
      Schema.decodeUnknownEffect(Schema.toCodecJson(NotesRuntime.createInputSchema))({ id: "forged-note", ownerId: "bob", text: "forged" }),
      Effect.result,
    )

    const rejectedPayload = Result.isFailure(forgedPayload)

    expect(rejectedPayload).toBe(true)

    const aliceCreated = client["private_notes.create"]({ id: "alice-created", text: "alice authored" }, { headers: aliceHeaders })
    const bobCreated = client["private_notes.create"]({ id: "bob-created", text: "bob authored" }, { headers: bobHeaders })
    const created = yield* Effect.all({ alice: aliceCreated, bob: bobCreated }, { concurrency: 2 })

    expect(created.alice.ownerId).toBe("alice")
    expect(created.bob.ownerId).toBe("bob")

    const anonymous = yield* pipe(client["private_notes.get"]({ id: "alice-note" }), Effect.flip, Effect.map(Struct.get("_tag")))

    expect(anonymous).toBe("Unauthenticated")

    const aliceRead = client["private_notes.get"]({ id: "alice-note" }, { headers: aliceHeaders })
    const bobRead = client["private_notes.get"]({ id: "bob-note" }, { headers: bobHeaders })
    const results = yield* Effect.all({ alice: aliceRead, bob: bobRead }, { concurrency: 2 })

    expect(results.alice.text).toBe("alice secret")
    expect(results.bob.text).toBe("bob secret")

    const crossIdentity = yield* pipe(client["private_notes.get"]({ id: "alice-note" }, { headers: bobHeaders }), Effect.flip, Effect.map(Struct.get("_tag")))

    expect(crossIdentity).toBe("ResourceNotFound")

    const forgedClaims = yield* pipe(client["private_notes.get"]({ id: "alice-note" }, { headers: { userId: "alice" } }), Effect.flip, Effect.map(Struct.get("_tag")))

    expect(forgedClaims).toBe("Unauthenticated")
  }),
  Effect.provide(NotesRuntime.handlers),
  Effect.provide(AuthorizationRpc.layer),
  Effect.provideService(AuthorizationRpc.Authenticator, authenticator),
  Effect.provideService(AuthorizationSubject, { userId: "captured-identity" }),
  Effect.provide(sqlite),
))

it.effect("missing RPC authentication provider cannot fall back to a captured subject", () => pipe(
  Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(NotesRuntime.group)
    const denied = yield* pipe(client["private_notes.get"]({ id: "alice-note" }, { headers: aliceHeaders }), Effect.flip, Effect.map(Struct.get("_tag")))

    expect(denied).toBe("Unauthenticated")
  }),
  Effect.provide(NotesRuntime.handlers),
  Effect.provide(AuthorizationRpc.layer),
  Effect.provideService(AuthorizationSubject, { userId: "alice" }),
  Effect.provide(sqlite),
))

const operator = Authorization.subject(NoteReaderSchema)
const allowedOperator = operator.eq(operator.subject.userId, "alice")
const operatorPolicy = operator.policy(allowedOperator)
const unrestrictedRead = p.all()
const protectedNotesPolicy = p.policy({ scope: operatorPolicy.expression, allow: { read: unrestrictedRead } })

const operatorNoteCapabilities = [Resource.get()]

const OperatorNotes = Resource.define({
  name: "operator_notes",
  schema: PrivateNoteSchema,
  authorization: protectedNotesPolicy,
  capabilities: operatorNoteCapabilities,
})

const operatorNotesTable = Resource.table(OperatorNotes)

const OperatorNotesRuntime = Resource.compile(OperatorNotes)

const changeNote = Rpc.make("operator.change", { payload: { text: Schema.String }, success: Schema.Void })
  .middleware(AuthorizationRpc)
  .annotate(AuthorizationRpc.policy, operatorPolicy)

const identifyOperator = Rpc.make("operator.identity", { success: Schema.String }).middleware(AuthorizationRpc)
const operatorCommands = RpcGroup.make(changeNote, identifyOperator)
const operatorGroup = OperatorNotesRuntime.group.merge(operatorCommands)

const operatorHandlers = operatorCommands.toLayer({
  "operator.change": Effect.fn("AuthorizationRpc.changeNote")(function* ({ text }) {
    const sql = yield* SqlClient.SqlClient

    yield* pipe(sql`UPDATE operator_notes SET text = ${text} WHERE id = 'one'`, Effect.orDie)
  }),
  "operator.identity": Effect.fn("AuthorizationRpc.identifyOperator")(function* () {
    const subject = yield* AuthorizationSubject

    return yield* pipe(Schema.decodeUnknownEffect(Schema.String)(subject["userId"]), Effect.orDie)
  }),
})

const protectedHandlers = Layer.merge(OperatorNotesRuntime.handlers, operatorHandlers)

it.effect("a shared subject policy protects resource reads and authored writes without leaking between RPCs", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([operatorNotesTable])

    const sql = yield* SqlClient.SqlClient

    yield* sql`INSERT INTO operator_notes (id, ownerId, text) VALUES ('one', 'alice', 'original')`

    const client = yield* RpcTest.makeClient(operatorGroup)
    const anonymous = yield* pipe(client["operator.change"]({ text: "anonymous" }), Effect.flip)

    expect(anonymous._tag).toBe("Unauthenticated")

    const denied = yield* pipe(client["operator.change"]({ text: "bob" }, { headers: bobHeaders }), Effect.flip)

    expect(denied._tag).toBe("Forbidden")

    const hidden = yield* pipe(client["operator_notes.get"]({ id: "one" }, { headers: bobHeaders }), Effect.flip)

    expect(hidden._tag).toBe("ResourceNotFound")

    const original = yield* client["operator_notes.get"]({ id: "one" }, { headers: aliceHeaders })

    expect(original.text).toBe("original")

    const identity = yield* client["operator.identity"](undefined, { headers: bobHeaders })

    expect(identity).toBe("bob")
    yield* client["operator.change"]({ text: "approved" }, { headers: aliceHeaders })

    const changed = yield* client["operator_notes.get"]({ id: "one" }, { headers: aliceHeaders })

    expect(changed.text).toBe("approved")
  }),
  Effect.provide(protectedHandlers),
  Effect.provide(AuthorizationRpc.layer),
  Effect.provideService(AuthorizationRpc.Authenticator, authenticator),
  Effect.provideService(AuthorizationSubject, { userId: "alice" }),
  Effect.provide(sqlite),
))
