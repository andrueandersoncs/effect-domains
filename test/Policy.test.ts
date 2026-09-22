import { expect, it } from "@effect/vitest"
import { Array, Effect, Option, Ref, Result, Schema, Struct, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Authorization, AuthorizationSubject, AuthorizationValues } from "effect-domains/authorization"
import { Entitlements } from "effect-domains/entitlements"
import { OperandSchema, Policy, PolicyEnvironment, type Operand } from "effect-domains/policy"
import { PolicySql } from "effect-domains/policy-sql"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"

const equalityPolicy = (left: Operand, right: Operand) => Policy.Schema.make({ _tag: "Equal", left, right })
const membershipPolicy = (collection: Operand, value: Operand) => Policy.Schema.make({ _tag: "Includes", collection, value })
const rowField = (field: string) => OperandSchema.make({ _tag: "RowField", field })
const subjectField = (field: string) => OperandSchema.make({ _tag: "SubjectField", field })
const sqlite = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })

const rowId = Struct.get<Readonly<Record<string, unknown>>, "id">("id")
const rowIds = Array.map(rowId)
const hostile = "x' OR 1=1 --"
const subject = { allowed: [null, "one", hostile], minimum: 1, role: "reader" }
const absent = Option.none()
const environment = new PolicyEnvironment({ subject, row: absent, next: absent })
const label = rowField("label")
const amount = rowField("amount")
const minimum = subjectField("minimum")
const allowed = subjectField("allowed")
const nullLiteral = Policy.literal(null)
const zeroLiteral = Policy.literal(0)
const oneLiteral = Policy.literal(1)
const twoLiteral = Policy.literal(2)
const textOneLiteral = Policy.literal("1")
const otherLiteral = Policy.literal("other")
const hostileLiteral = Policy.literal(hostile)
const trueLiteral = Policy.literal(true)
const emptyLiteral = Policy.literal([])
const nullable = equalityPolicy(label, nullLiteral)
const minimumAmount = equalityPolicy(amount, minimum)
const hostileLabel = equalityPolicy(label, hostileLiteral)
const membership = membershipPolicy(allowed, label)
const zeroAmount = equalityPolicy(amount, zeroLiteral)
const twoAmount = equalityPolicy(amount, twoLiteral)
const selectedAmounts = Policy.any(zeroAmount, twoAmount)
const combined = Policy.all(membership, selectedAmounts)
const otherLabel = equalityPolicy(label, otherLiteral)
const nullableOrOther = Policy.any(nullable, otherLabel)
const differentBoolean = equalityPolicy(trueLiteral, oneLiteral)
const differentString = equalityPolicy(textOneLiteral, oneLiteral)
const emptyMembership = membershipPolicy(emptyLiteral, label)
const rowKindsDiffer = equalityPolicy(label, amount)
const policies = [Policy.constant(true), Policy.constant(false), Policy.all(), Policy.any(), nullable, minimumAmount, hostileLabel, membership, combined, nullableOrOther, differentBoolean, differentString, emptyMembership, rowKindsDiffer]

it.effect("the same policy selects identical canonical and SQL rows including nulls and hostile literals", () => pipe(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* sql`CREATE TABLE policy_rows (id INTEGER PRIMARY KEY, label TEXT, amount REAL NOT NULL)`
    yield* sql`INSERT INTO policy_rows (id, label, amount) VALUES (1, NULL, 0), (2, 'one', 1), (3, ${hostile}, 2), (4, '1', 1), (5, 'other', 3)`

    const rows = yield* sql<Readonly<Record<string, unknown>>>`SELECT * FROM policy_rows ORDER BY id`

    const verifyPolicy = Effect.fn("Policy.testParity")(function* (source: Policy) {
      const json = JSON.stringify(source)
      const raw: unknown = JSON.parse(json)
      const policy = yield* Schema.decodeUnknownEffect(Policy.Schema)(raw)
      const evaluate = Policy.evaluate(policy)

      const visible = (row: Readonly<Record<string, unknown>>) => {
        const present = Option.some(row)

        return pipe(new PolicyEnvironment({ subject, row: present, next: absent }), evaluate)
      }

      const expected = yield* pipe(Effect.filter(rows, visible), Effect.map(rowIds))
      const predicate = yield* PolicySql.compile(policy)(sql, environment)
      const actualRows = yield* sql<Readonly<Record<string, unknown>>>`SELECT id FROM policy_rows WHERE ${predicate} ORDER BY id`
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
  const nextOwner = OperandSchema.make({ _tag: "NextField", field: "owner" })
  const alice = Policy.literal("alice")
  const missing = equalityPolicy(nextOwner, alice)
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
  const SubjectSchema = Schema.Struct({ tenantId: Schema.String })
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
  const otherSubject = Authorization.subject(OtherSubjectSchema)
  const otherAccess = otherSubject.all()
  const other = otherSubject.policy(otherAccess)

  expect(() => resource.policy({ scope: other, allow: { read: allow } })).toThrow()
}))
