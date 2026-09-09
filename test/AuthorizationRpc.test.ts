import { expect, it } from "@effect/vitest"
import { Effect, Option, Record, Result, Schema, Struct, pipe } from "effect"
import { Headers } from "effect/unstable/http"
import { RpcTest } from "effect/unstable/rpc"
import { SqlClient } from "effect/unstable/sql"
import { Authorization, AuthorizationSubject, Unauthenticated } from "effect-domains/authorization"
import { Authenticator, AuthorizationRpc } from "effect-domains/authorization-rpc"
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
const Notes = Resource.make({
  name: "private_notes",
  schema: PrivateNoteSchema,
  authorization: policy,
  create: { fromSubject: { ownerId: p.subject.userId } },
  operations: ["get", "create"],
})
const SessionsSchema = Schema.Record(Schema.String, NoteReaderSchema)
interface Sessions extends Schema.Schema.Type<typeof SessionsSchema> {}
const sessions = SessionsSchema.make({ "Bearer alice-session": { userId: "alice" }, "Bearer bob-session": { userId: "bob" } })
const sessionFor = (token: string) => Record.get(sessions, token)

const authenticate = Effect.fn("AuthorizationRpc.testAuthenticate")(function* (headers: Headers.Headers) {
  const subject = pipe(Headers.get(headers, "authorization"), Option.flatMap(sessionFor))
  return yield* Effect.fromOption(subject, () => Unauthenticated.make({}))
})

const authenticator = Authenticator.of({ authenticate })
const sqlite = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })
const aliceHeaders = { authorization: "Bearer alice-session" }
const bobHeaders = { authorization: "Bearer bob-session" }

it.effect("RPC authentication overrides captured identity and isolates concurrent requests", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([Notes.table])
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO private_notes (id, ownerId, text) VALUES ('alice-note', 'alice', 'alice secret'), ('bob-note', 'bob', 'bob secret')`
    const client = yield* RpcTest.makeClient(Notes.group)
    const forgedPayload = yield* pipe(
      Schema.decodeUnknownEffect(Schema.toCodecJson(Notes.createInputSchema))({ id: "forged-note", ownerId: "bob", text: "forged" }),
      Effect.result,
    )
    expect(Result.isFailure(forgedPayload)).toBe(true)

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
  Effect.provide(Notes.handlers),
  Effect.provide(AuthorizationRpc.layer),
  Effect.provideService(Authenticator, authenticator),
  Effect.provideService(AuthorizationSubject, { userId: "captured-identity" }),
  Effect.provide(sqlite),
))

it.effect("missing RPC authentication provider cannot fall back to a captured subject", () => pipe(
  Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(Notes.group)
    const denied = yield* pipe(client["private_notes.get"]({ id: "alice-note" }, { headers: aliceHeaders }), Effect.flip, Effect.map(Struct.get("_tag")))
    expect(denied).toBe("Unauthenticated")
  }),
  Effect.provide(Notes.handlers),
  Effect.provide(AuthorizationRpc.layer),
  Effect.provideService(AuthorizationSubject, { userId: "alice" }),
  Effect.provide(sqlite),
))
