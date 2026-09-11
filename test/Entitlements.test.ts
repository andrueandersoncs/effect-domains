import { expect, it } from "@effect/vitest"
import { Array, Effect, Equivalence, Function, Option, Predicate, Record, Ref, Schema, Struct, pipe } from "effect"
import { Headers } from "effect/unstable/http"
import { RpcTest } from "effect/unstable/rpc"
import { SqlClient } from "effect/unstable/sql"
import { Authorization, AuthorizationSubject, AuthorizationValues, Unauthenticated } from "effect-domains/authorization"
import { Entitlements, EntitlementUnavailable } from "effect-domains/entitlements"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { identifier } from "effect-domains/domain"
import { Resource } from "effect-domains/resource"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { prepareTables } from "./prepare-tables.ts"

const equals = Equivalence.strictEqual<unknown>()
const SubjectSchema = Schema.Struct({ userId: Schema.String, tenantId: Schema.String })
const ReportSchema = Schema.Struct({ id: identifier(Schema.String), tenantId: Schema.String, title: Schema.String })
const p = Authorization.for({ resource: ReportSchema, subject: SubjectSchema })
const scope = p.eq(p.row.tenantId, p.subject.tenantId)
const access = p.all()
const purchase = p.entitlement({ name: "purchased_report", key: p.row.id })
const account = p.entitlement({ name: "report_exports", key: p.subject.tenantId })
const purchasedPolicy = p.policy({ scope, allow: { read: access }, require: { read: [purchase] } })

const PurchasedReports = Resource.make({
  name: "purchased_reports", schema: ReportSchema, authorization: purchasedPolicy,
  operations: { get: true, list: { limit: 2 } },
})

const accountPolicy = p.policy({ scope, allow: { read: access }, require: { read: [account] } })

const AccountReports = Resource.make({
  name: "account_reports", schema: ReportSchema, authorization: accountPolicy, operations: { list: true },
})

const WriteSchema = Schema.Struct({ id: identifier(Schema.String), tenantId: Schema.String, visible: Schema.Boolean })
const w = Authorization.for({ resource: WriteSchema, subject: SubjectSchema })
const writeAccess = w.all()
const readable = w.eq(w.row.visible, true)
const publish = w.entitlement({ name: "publish_reports", key: w.subject.tenantId })
const readGrant = w.entitlement({ name: "read_reports", key: w.row.tenantId })

const paidWritePolicy = w.policy({
  scope: writeAccess,
  allow: { read: readable, create: writeAccess },
  require: { create: [publish], read: [readGrant] },
})

const PaidWrites = Resource.make({ name: "paid_writes", schema: WriteSchema, authorization: paidWritePolicy, operations: { create: true } })
const s = Authorization.subject(SubjectSchema)
const aliceOnly = s.eq(s.subject.userId, "alice")
const subjectAccess = s.all()
const subjectAccount = s.entitlement({ name: "report_exports", key: s.subject.tenantId })
const paidSubjectPolicy = s.policy(aliceOnly, { require: [subjectAccount] })
const alice = SubjectSchema.make({ userId: "alice", tenantId: "a" })
const bob = SubjectSchema.make({ userId: "bob", tenantId: "b" })
const asAlice = Effect.provideService(AuthorizationSubject, alice)
const sqlite = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })
const denied = Entitlements.of({ has: () => Effect.succeed(false) })
const admitted = Entitlements.of({ has: () => Effect.succeed(true) })

it.effect("account gates reject empty lists, distinguish resolver outages, and observe revocation", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([AccountReports.table])
    const locked = yield* pipe(AccountReports.repository.list(), asAlice, Effect.provideService(Entitlements, denied), Effect.flip)
    expect(locked._tag).toBe("EntitlementRequired")
    const missing = yield* pipe(AccountReports.repository.list(), asAlice, Effect.flip)
    expect(missing._tag).toBe("EntitlementUnavailable")
    const unavailable = Entitlements.of({ has: () => EntitlementUnavailable.make({}) })
    const outage = yield* pipe(AccountReports.repository.list(), asAlice, Effect.provideService(Entitlements, unavailable), Effect.flip)
    expect(outage._tag).toBe("EntitlementUnavailable")
    const granted = yield* Ref.make(false)
    const dynamic = Entitlements.of({ has: () => Ref.get(granted) })
    const list = pipe(AccountReports.repository.list(), asAlice, Effect.provideService(Entitlements, dynamic))
    const initial = yield* Effect.flip(list)
    expect(initial._tag).toBe("EntitlementRequired")
    yield* Ref.set(granted, true)
    const allowed = yield* list
    expect(allowed).toEqual({ items: [], nextCursor: null })
    yield* Ref.set(granted, false)
    const revoked = yield* Effect.flip(list)
    expect(revoked._tag).toBe("EntitlementRequired")
  }), Effect.provide(sqlite),
))

it.effect("purchase gates preserve hidden rows and pagination without filtering locked items", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([PurchasedReports.table])
    const sql = yield* SqlClient.SqlClient

    yield* sql`INSERT INTO purchased_reports (id, tenantId, title) VALUES
      ('0-hidden', 'b', 'secret'), ('1-paid', 'a', 'available'), ('2-locked', 'a', 'locked')`

    const purchases = Entitlements.of({ has: ({ key }) => Effect.sync(() => equals(key, "1-paid")) })
    // Omit the resolver because premature entitlement lookup must not reveal hidden rows.
    const hidden = yield* pipe(PurchasedReports.repository.get("0-hidden"), asAlice, Effect.flip)
    expect(hidden._tag).toBe("ResourceNotFound")
    const paid = yield* pipe(PurchasedReports.repository.get("1-paid"), asAlice, Effect.provideService(Entitlements, purchases))
    expect(paid.title).toBe("available")
    const first = yield* pipe(PurchasedReports.repository.list({ limit: 1 }), asAlice, Effect.provideService(Entitlements, purchases))
    expect(first.items).toEqual([paid])
    const cursor = yield* Effect.fromNullishOr(first.nextCursor)
    const continuation = yield* pipe(PurchasedReports.repository.list({ limit: 1, cursor }), asAlice, Effect.provideService(Entitlements, purchases), Effect.flip)
    expect(continuation._tag).toBe("EntitlementRequired")
    const mixed = yield* pipe(PurchasedReports.repository.list({ limit: 2 }), asAlice, Effect.provideService(Entitlements, purchases), Effect.flip)
    expect(mixed._tag).toBe("EntitlementRequired")
  }), Effect.provide(sqlite),
))

it.effect("denied writes and entitlement revocation during a write leave no partial state", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([PaidWrites.table])
    const deniedInput = WriteSchema.make({ id: "denied", tenantId: "a", visible: true })
    const deniedWrite = yield* pipe(PaidWrites.repository.create(deniedInput), asAlice, Effect.provideService(Entitlements, denied), Effect.flip)
    expect(deniedWrite._tag).toBe("EntitlementRequired")
    const unreadableInput = WriteSchema.make({ id: "unreadable", tenantId: "a", visible: false })
    const unreadable = yield* pipe(PaidWrites.repository.create(unreadableInput), asAlice, Effect.provideService(Entitlements, admitted), Effect.flip)
    expect(unreadable._tag).toBe("Forbidden")
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE grants (active INTEGER NOT NULL)`
    yield* sql`INSERT INTO grants VALUES (1)`
    yield* sql`CREATE TRIGGER revoke_after_insert AFTER INSERT ON paid_writes BEGIN UPDATE grants SET active = 0; END`

    const currentGrant = Entitlements.of({
      has: Effect.fn("Entitlements.test.currentGrant")(function* () {
        const rows = yield* pipe(sql<{ readonly active: number }>`SELECT active FROM grants WHERE active = 1`, Effect.mapError(() => EntitlementUnavailable.make({})))
        return rows.length > 0
      }),
    })

    const revokedInput = WriteSchema.make({ id: "revoked", tenantId: "a", visible: true })
    const revokedWrite = yield* pipe(PaidWrites.repository.create(revokedInput), asAlice, Effect.provideService(Entitlements, currentGrant), Effect.flip)
    expect(revokedWrite._tag).toBe("EntitlementRequired")
    const rows = yield* sql`SELECT id FROM paid_writes`
    expect(rows).toEqual([])
    const grants = yield* sql`SELECT active FROM grants`
    expect(grants).toEqual([{ active: 1 }])
  }), Effect.provide(sqlite),
))

it.effect("standalone and subject policies enforce requirements after ordinary subject permission", () => pipe(
  Effect.gen(function* () {
    const report = ReportSchema.make({ id: "report", tenantId: "a", title: "export" })
    const row = Option.some(report)
    const next = Option.none()
    const values = new AuthorizationValues({ row, next })
    const accountDenied = yield* pipe(Authorization.require(accountPolicy, "read", values), asAlice, Effect.provideService(Entitlements, denied), Effect.flip)
    expect(accountDenied._tag).toBe("EntitlementRequired")
    const purchaseDenied = yield* pipe(Authorization.require(purchasedPolicy, "read", values), asAlice, Effect.provideService(Entitlements, denied), Effect.flip)
    expect(purchaseDenied._tag).toBe("EntitlementRequired")
    const subjectDenied = yield* pipe(Authorization.requireSubject(paidSubjectPolicy), asAlice, Effect.provideService(Entitlements, denied), Effect.flip)
    expect(subjectDenied._tag).toBe("EntitlementRequired")
    const forbidden = yield* pipe(Authorization.requireSubject(paidSubjectPolicy), Effect.provideService(AuthorizationSubject, bob), Effect.flip)
    expect(forbidden._tag).toBe("Forbidden")
    const allowed = yield* pipe(Authorization.requireSubject(paidSubjectPolicy), asAlice, Effect.provideService(Entitlements, admitted))
    expect(allowed).toEqual(alice)
  }),
))

it.effect("entitlement declarations validate phases and snapshot mutable inputs", () => pipe(
  Effect.gen(function* () {
    const requirement = s.entitlement({ name: "report_exports", key: s.subject.tenantId })
    const requirements = [requirement]
    const policy = s.policy(subjectAccess, { require: requirements })
    const replacement = s.entitlement({ name: "rewritten", key: s.subject.userId })

    yield* Effect.sync(() => {
      Reflect.set(requirement, "name", "mutated")
      Reflect.set(requirement.key, "field", "userId")
      Reflect.set(requirements, "0", replacement)
    })

    const resolver = Entitlements.of({ has: ({ name, key }) => Effect.sync(() => equals(name, "report_exports") && equals(key, "a")) })
    const allowed = yield* pipe(Authorization.requireSubject(policy), asAlice, Effect.provideService(Entitlements, resolver))
    expect(allowed).toEqual(alice)
    expect(() => p.policy({ scope, allow: { read: access }, require: { read: [{ name: "", key: p.subject.tenantId } as never] } })).toThrow()
    expect(() => p.policy({ scope, allow: { create: access }, require: { create: [purchase as never] } })).toThrow()
    expect(() => s.policy(subjectAccess, { require: [purchase as never] })).toThrow()
  }),
))

const sessions = Record.fromEntries([["Bearer alice", alice], ["Bearer bob", bob]])

const authenticator = AuthorizationRpc.Authenticator.of({
  authenticate: (headers) => pipe(
    Headers.get(headers, "authorization"),
    Option.flatMap((token) => Record.get(sessions, token)),
    Effect.fromOption(() => Unauthenticated.make({})),
  ),
})

const accountResolver = Entitlements.of({ has: ({ subject, key }) => Effect.sync(() => equals(subject.tenantId, "a") && equals(key, "a")) })

it.effect("RPC gates isolate request identity and return typed entitlement errors", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([AccountReports.table])
    const client = yield* RpcTest.makeClient(AccountReports.group)
    const aliceRequest = client["account_reports.list"]({}, { headers: { authorization: "Bearer alice" } })
    const bobRequest = pipe(client["account_reports.list"]({}, { headers: { authorization: "Bearer bob" } }), Effect.flip)
    const [alicePage, bobFailure] = yield* Effect.all([aliceRequest, bobRequest], { concurrency: "unbounded" })
    expect(alicePage).toEqual({ items: [], nextCursor: null })
    expect(bobFailure._tag).toBe("EntitlementRequired")
    if (Predicate.isTagged(bobFailure, "EntitlementRequired")) expect(bobFailure.entitlement).toBe("report_exports")
  }),
  Effect.provide(AccountReports.handlers),
  Effect.provide(AuthorizationRpc.layer),
  Effect.provideService(AuthorizationRpc.Authenticator, authenticator),
  Effect.provideService(Entitlements, accountResolver),
  asAlice,
  Effect.provide(sqlite),
))
