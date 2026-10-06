import { expect, it } from "@effect/vitest"
import { Array, Effect, Option, Ref, Result, Schema, Struct, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Authorization } from "effect-domains/authorization"
import { AuthorizationSubject, AuthorizationValues } from "effect-domains/authorization-model"
import { Entitlements } from "effect-domains/entitlements"
import { NextFieldSchema, OperandSchema, Policy, PolicyEnvironment, RowFieldSchema, SubjectFieldSchema } from "effect-domains/policy"
import { PolicySql } from "effect-domains/policy-sql"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"

const sqlite = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })
const PolicyRowSchema = Schema.Struct({ id: Schema.Int, label: Schema.NullOr(Schema.String), amount: Schema.Number })

interface PolicyRow extends Schema.Schema.Type<typeof PolicyRowSchema> {}

const rowId = Struct.get<PolicyRow, "id">("id")
const rowIds = Array.map(rowId)
const hostile = "x' OR 1=1 --"
const subject = { allowed: [null, "one", hostile], minimum: 1, role: "reader" }
const absent = Option.none()
const environment = new PolicyEnvironment({ subject, row: absent, next: absent })
const label = RowFieldSchema.make({ field: "label" })
const amount = RowFieldSchema.make({ field: "amount" })
const minimum = SubjectFieldSchema.make({ field: "minimum" })
const allowed = SubjectFieldSchema.make({ field: "allowed" })
const nullLiteral = Policy.literal(null)
const zeroLiteral = Policy.literal(0)
const oneLiteral = Policy.literal(1)
const twoLiteral = Policy.literal(2)
const textOneLiteral = Policy.literal("1")
const otherLiteral = Policy.literal("other")
const hostileLiteral = Policy.literal(hostile)
const trueLiteral = Policy.literal(true)
const emptyLiteral = Policy.literal([])
const nullable = Policy.EqualSchema.make({ left: label, right: nullLiteral })
const minimumAmount = Policy.EqualSchema.make({ left: amount, right: minimum })
const hostileLabel = Policy.EqualSchema.make({ left: label, right: hostileLiteral })
const membership = Policy.IncludesSchema.make({ collection: allowed, value: label })
const zeroAmount = Policy.EqualSchema.make({ left: amount, right: zeroLiteral })
const twoAmount = Policy.EqualSchema.make({ left: amount, right: twoLiteral })
const selectedAmounts = Policy.any(zeroAmount, twoAmount)
const combined = Policy.all(membership, selectedAmounts)
const otherLabel = Policy.EqualSchema.make({ left: label, right: otherLiteral })
const nullableOrOther = Policy.any(nullable, otherLabel)
const differentBoolean = Policy.EqualSchema.make({ left: trueLiteral, right: oneLiteral })
const differentString = Policy.EqualSchema.make({ left: textOneLiteral, right: oneLiteral })
const emptyMembership = Policy.IncludesSchema.make({ collection: emptyLiteral, value: label })
const rowKindsDiffer = Policy.EqualSchema.make({ left: label, right: amount })
const policies = [Policy.constant(true), Policy.constant(false), Policy.all(), Policy.any(), nullable, minimumAmount, hostileLabel, membership, combined, nullableOrOther, differentBoolean, differentString, emptyMembership, rowKindsDiffer]

it.effect("the same policy selects identical canonical and SQL rows including nulls and hostile literals", () => pipe(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* sql`CREATE TABLE policy_rows (id INTEGER PRIMARY KEY, label TEXT, amount REAL NOT NULL)`
    yield* sql`INSERT INTO policy_rows (id, label, amount) VALUES (1, NULL, 0), (2, 'one', 1), (3, ${hostile}, 2), (4, '1', 1), (5, 'other', 3)`

    const rows = yield* sql<PolicyRow>`SELECT * FROM policy_rows ORDER BY id`

    const verifyPolicy = Effect.fn("Policy.testParity")(function* (source: Policy) {
      const json = JSON.stringify(source)
      const raw: unknown = JSON.parse(json)
      const policy = yield* Schema.decodeUnknownEffect(Policy.Schema)(raw)
      const evaluate = Policy.evaluate(policy)

      const visible = (row: PolicyRow) => {
        const present = Option.some(row)

        return pipe(new PolicyEnvironment({ subject, row: present, next: absent }), evaluate)
      }

      const expected = yield* pipe(Effect.filter(rows, visible), Effect.map(rowIds))
      const predicate = yield* PolicySql.compile(policy)(sql, environment)
      const actualRows = yield* sql<Pick<PolicyRow, "id">>`SELECT id FROM policy_rows WHERE ${predicate} ORDER BY id`
      const actual = Array.map(actualRows, Struct.get("id"))

      expect(actual).toEqual(expected)
    })

    yield* Effect.forEach(policies, verifyPolicy)

    const binder = PolicySql.compile(minimumAmount)
    const firstEnvironment = new PolicyEnvironment({ subject: { minimum: 1 }, row: absent, next: absent })
    const secondEnvironment = new PolicyEnvironment({ subject: { minimum: 3 }, row: absent, next: absent })
    const first = yield* binder(sql, firstEnvironment)
    const second = yield* binder(sql, secondEnvironment)
    const firstRows = yield* sql`SELECT id FROM policy_rows WHERE ${first} ORDER BY id`
    const secondRows = yield* sql`SELECT id FROM policy_rows WHERE ${second} ORDER BY id`

    expect(firstRows).toEqual([{ id: 2 }, { id: 4 }])
    expect(secondRows).toEqual([{ id: 5 }])
  }), Effect.provide(sqlite),
))

it.effect("fold evaluation short circuits without turning missing operands or malformed syntax into grants", Effect.fn("Policy.testShortCircuit")(function* () {
  const nextOwner = NextFieldSchema.make({ field: "owner" })
  const alice = Policy.literal("alice")
  const missing = Policy.EqualSchema.make({ left: nextOwner, right: alice })
  const yes = Policy.constant(true)
  const no = Policy.constant(false)
  const alternative = Policy.any(yes, missing)
  const conjunction = Policy.all(no, missing)
  const required = Policy.all(yes, missing)
  const granted = yield* Policy.evaluate(alternative)(environment)
  const denied = yield* Policy.evaluate(conjunction)(environment)

  expect(granted).toBe(true)
  expect(denied).toBe(false)

  const failure = yield* pipe(Policy.evaluate(required)(environment), Effect.result, Effect.map(Result.isFailure))

  expect(failure).toBe(true)

  const unknown = yield* pipe(Schema.decodeUnknownEffect(Policy.Schema)({ _tag: "Execute", code: "allow" }), Effect.result, Effect.map(Result.isFailure))

  expect(unknown).toBe(true)

  const invalidScalar = yield* pipe(Schema.decodeUnknownEffect(OperandSchema)({ _tag: "Literal", value: Infinity }), Effect.result, Effect.map(Result.isFailure))

  expect(invalidScalar).toBe(true)
}))

it.effect("embedded subject policies apply scope and action entitlement requirements", Effect.fn("Policy.embeddedSubjectPolicies")(function* () {
  const ResourceSchema = Schema.Struct({ tenantId: Schema.String })
  
  interface Resource extends Schema.Schema.Type<typeof ResourceSchema> {}

  const SubjectSchema = Schema.Struct({ tenantId: Schema.String })
  
  interface Subject extends Schema.Schema.Type<typeof SubjectSchema> {}

  const resource = Authorization.for({ resource: ResourceSchema, subject: SubjectSchema })
  const subject = Authorization.subject(SubjectSchema)
  const scopeRequirement = subject.entitlement({ name: "scope", key: subject.subject.tenantId })
  const actionRequirement = subject.entitlement({ name: "action", key: subject.subject.tenantId })
  const scopeAccess = subject.all()
  const actionAccess = subject.all()
  const scope = subject.policy(scopeAccess, { require: [scopeRequirement] })
  const allow = subject.policy(actionAccess, { require: [actionRequirement] })
  const authorization = resource.policy({ scope, allow: { read: allow } })
  const resourceRow = ResourceSchema.make({ tenantId: "a" })
  const currentRow = Option.some(resourceRow)
  const absentNext = Option.none()
  const values = new AuthorizationValues({ row: currentRow, next: absentNext })
  const calls = yield* Ref.make<ReadonlyArray<string>>([])

  const entitlements = Entitlements.of({
    has: ({ name }) => pipe(
      Ref.update(calls, Array.append(name)),
      Effect.as(true),
    ),
  })

  const activeSubject = SubjectSchema.make({ tenantId: "a" })

  yield* pipe(
    Authorization.require(authorization, "read", values),
    Effect.provideService(AuthorizationSubject, activeSubject),
    Effect.provideService(Entitlements, entitlements),
  )

  const entitlementCalls = yield* Ref.get(calls)

  expect(entitlementCalls).toContain("scope")
  expect(entitlementCalls).toContain("action")

  const OtherSubjectSchema = Schema.Struct({ tenantId: Schema.String })
  
  interface OtherSubject extends Schema.Schema.Type<typeof OtherSubjectSchema> {}

  const otherSubject = Authorization.subject(OtherSubjectSchema)
  const otherAccess = otherSubject.all()
  const other = otherSubject.policy(otherAccess)

  expect(() => resource.policy({ scope: other, allow: { read: allow } })).toThrow()
}))
