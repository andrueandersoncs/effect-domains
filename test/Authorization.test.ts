import { expect, it } from "@effect/vitest"
import { Array, Effect, Equivalence, Option, Order, Result, Schema, Struct, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Authorization, AuthorizationSubject, AuthorizationValues, type PolicyAuthorization } from "effect-domains/authorization"
import { identifier } from "effect-domains/domain"
import { Resource } from "effect-domains/resource"
import { Policy, type Policy as PolicySyntax } from "effect-domains/policy"
import { RepositoryStore } from "effect-domains/repository-store"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { Table } from "effect-domains/table"
import { prepareTables } from "./prepare-tables.ts"

const SubjectSchema = Schema.Struct({ userId: Schema.String, tenantId: Schema.String, roles: Schema.Array(Schema.String) })
interface Subject extends Schema.Schema.Type<typeof SubjectSchema> {}

const OwnedDocumentSchema = Schema.Struct({
  id: identifier(Schema.String), tenantId: Schema.String, ownerId: Schema.String, title: Schema.NonEmptyString,
})

interface OwnedDocument extends Schema.Schema.Type<typeof OwnedDocumentSchema> {}

const policyMarkerEquals = Equivalence.strictEqual<string>()

const FabricatedPolicyShapeSchema = Schema.TaggedStruct("Policy", {
  resource: Schema.Unknown,
  subject: Schema.Unknown,
  scope: Policy.Schema,
  allow: Schema.Record(Schema.String, Policy.Schema),
})

const FabricatedPolicySchema = Schema.make<Schema.Codec<PolicyAuthorization>>(FabricatedPolicyShapeSchema.ast)

const p = Authorization.for({ resource: OwnedDocumentSchema, subject: SubjectSchema })
const unrestricted = p.all()
const scope = p.eq(p.row.tenantId, p.subject.tenantId)
const owned = p.eq(p.row.ownerId, p.subject.userId)
const administrator = p.includes(p.subject.roles, "admin")
const ownerOrAdmin = p.any(owned, administrator)
const unchangedOwnership = p.unchanged("tenantId", "ownerId")
const edit = p.all(ownerOrAdmin, unchangedOwnership)
const ownedCandidate = p.eq(p.next.ownerId, p.subject.userId)
const policy = p.policy({ scope, allow: { read: ownerOrAdmin, create: ownedCandidate, update: edit, patch: edit, remove: ownerOrAdmin } })

const Documents = Resource.make({
  name: "authorized_documents", schema: OwnedDocumentSchema, authorization: policy,
  create: { fromSubject: { tenantId: p.subject.tenantId, ownerId: p.subject.userId } },
  operations: [...Resource.crud, "patch"],
  list: { filter: ["ownerId"], order: [{ field: "title" }], limit: 2 },
})

const alice = SubjectSchema.make({ userId: "alice", tenantId: "a", roles: [] })
const bob = SubjectSchema.make({ userId: "bob", tenantId: "a", roles: [] })
const admin = SubjectSchema.make({ userId: "admin", tenantId: "a", roles: ["admin"] })
const asAlice = Effect.provideService(AuthorizationSubject, alice)
const asBob = Effect.provideService(AuthorizationSubject, bob)
const asAdmin = Effect.provideService(AuthorizationSubject, admin)
const sqlite = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })
const documentId = Struct.get<OwnedDocument, "id">("id")
const documentIds = Array.map(documentId)

const rejectedTag = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  pipe(effect, Effect.flip, Effect.map(Struct.get<E, "_tag">("_tag")))

const seed = Effect.gen(function* () {
  yield* prepareTables([Documents.table])
  const sql = yield* SqlClient.SqlClient

  yield* sql`INSERT INTO authorized_documents (id, tenantId, ownerId, title) VALUES
    ('1', 'a', 'alice', 'alpha'), ('2', 'a', 'bob', 'bravo'),
    ('3', 'b', 'eve', 'charlie'), ('4', 'a', 'alice', 'delta')`
})

it.effect("repository visibility scopes identifiers and pagination before computing continuations", () => pipe(
  Effect.gen(function* () {
    yield* seed
    const unauthenticated = yield* pipe(Documents.repository.get("1"), rejectedTag)
    expect(unauthenticated).toBe("Unauthenticated")
    const invalidSubject = yield* pipe(Documents.repository.get("1"), Effect.provideService(AuthorizationSubject, { userId: "alice" }), rejectedTag)
    expect(invalidSubject).toBe("Unauthenticated")
    const hidden = yield* pipe(Documents.repository.find("2"), asAlice, Effect.map(Option.isNone))
    expect(hidden).toBe(true)
    const missing = yield* pipe(Documents.repository.get("absent"), asAlice, rejectedTag)
    const forbidden = yield* pipe(Documents.repository.get("2"), asAlice, rejectedTag)
    expect(forbidden).toBe(missing)
    expect(forbidden).toBe("ResourceNotFound")
    const tenantBoundary = yield* pipe(Documents.repository.get("3"), asAdmin, rejectedTag)
    expect(tenantBoundary).toBe("ResourceNotFound")
    const visible = yield* pipe(Documents.repository.list(), asAlice, Effect.map(documentIds), Effect.map(Array.sort(Order.String)))
    expect(visible).toEqual(["1", "4"])
    const first = yield* pipe(Documents.repository.page({ limit: 1 }), asAlice)
    const firstIds = documentIds(first.items)
    expect(firstIds).toEqual(["1"])
    const cursor = yield* Effect.fromNullishOr(first.nextCursor)
    const second = yield* pipe(Documents.repository.page({ limit: 1, cursor }), asAlice)
    const secondIds = documentIds(second.items)
    expect(secondIds).toEqual(["4"])
    expect(second.nextCursor).toBeNull()
    const replay = yield* pipe(Documents.repository.page({ limit: 2, cursor }), asBob)
    const replayIds = documentIds(replay.items)
    expect(replayIds).toEqual(["2"])
    expect(replay.nextCursor).toBeNull()
    const filtered = yield* pipe(Documents.repository.page({ filter: { ownerId: "bob" } }), asAlice)
    expect(filtered).toEqual({ items: [], nextCursor: null })
    const privileged = yield* pipe(Documents.repository.page({ limit: 1 }), asAdmin)
    const privilegedCursor = yield* Effect.fromNullishOr(privileged.nextCursor)
    const revoked = yield* pipe(Documents.repository.page({ cursor: privilegedCursor }), Effect.provideService(AuthorizationSubject, { ...admin, roles: [] }))
    expect(revoked).toEqual({ items: [], nextCursor: null })
  }), Effect.provide(sqlite),
))

it.effect("create update patch and remove enforce current and candidate authorization without partial writes", () => pipe(
  Effect.gen(function* () {
    yield* seed

    const forged = yield* pipe(
      Documents.repository.create({ id: "5", tenantId: "a", ownerId: "bob", title: "forged" } as never),
      asAlice,
      rejectedTag,
    )

    expect(forged).toBe("RepositoryError")

    const crossTenant = yield* pipe(
      Documents.repository.create({ id: "6", tenantId: "b", title: "cross" } as never),
      asAlice,
      rejectedTag,
    )

    expect(crossTenant).toBe("RepositoryError")
    const original = yield* pipe(Documents.repository.get("1"), asAlice)
    const transfer = yield* pipe(Documents.repository.update({ ...original, ownerId: "bob" }), asAdmin, rejectedTag)
    expect(transfer).toBe("Forbidden")
    const move = yield* pipe(Documents.repository.patch("1", { tenantId: "b" }), asAdmin, rejectedTag)
    expect(move).toBe("Forbidden")
    const hiddenPatch = yield* pipe(Documents.repository.patch("2", { ownerId: "alice" }), asAlice, rejectedTag)
    expect(hiddenPatch).toBe("ResourceNotFound")
    const hiddenDelete = yield* pipe(Documents.repository.remove("3"), asAdmin, rejectedTag)
    expect(hiddenDelete).toBe("ResourceNotFound")
    const unchanged = yield* pipe(Documents.repository.get("1"), asAlice)
    expect(unchanged).toEqual(original)
    const created = yield* pipe(Documents.repository.create({ id: "7", title: "new" }), asAlice)
    expect(created).toMatchObject({ id: "7", tenantId: "a", ownerId: "alice" })
    const changed = yield* pipe(Documents.repository.patch("7", { title: "changed" }), asAlice)
    expect(changed.title).toBe("changed")
    yield* pipe(Documents.repository.remove("7"), asAlice)
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<Pick<OwnedDocument, "id">>`SELECT id FROM authorized_documents ORDER BY id`
    const ids = Array.map(rows, Struct.get("id"))
    expect(ids).toEqual(["1", "2", "3", "4"])
  }), Effect.provide(sqlite),
))

it("rejects unsafe create subject binding definitions", () => {
  const make = (encodedDefinition: string) => {
    const definition = JSON.parse(encodedDefinition)
    const hasPolicyMarker = policyMarkerEquals(definition.authorization, "policy")
    const authorization = hasPolicyMarker ? policy : definition.authorization
    return Resource.make({ ...definition, authorization, schema: OwnedDocumentSchema, operations: [] })
  }

  expect(() => make('{"name":"public_binding","authorization":{"_tag":"Public"},"create":{"fromSubject":{"ownerId":{"_tag":"SubjectField","field":"userId"}}}}')).toThrow()
  expect(() => make('{"name":"deny_binding","authorization":{"_tag":"Deny"},"create":{"fromSubject":{"ownerId":{"_tag":"SubjectField","field":"userId"}}}}')).toThrow()
  expect(() => make('{"name":"unknown_target_binding","authorization":"policy","create":{"fromSubject":{"absent":{"_tag":"SubjectField","field":"userId"}}}}')).toThrow()
  expect(() => make('{"name":"non_subject_binding","authorization":"policy","create":{"fromSubject":{"ownerId":{"_tag":"RowField","field":"ownerId"}}}}')).toThrow()
  expect(() => make('{"name":"unknown_subject_binding","authorization":"policy","create":{"fromSubject":{"ownerId":{"_tag":"SubjectField","field":"absent"}}}}')).toThrow()
  expect(() => make('{"name":"incompatible_binding","authorization":"policy","create":{"fromSubject":{"ownerId":{"_tag":"SubjectField","field":"roles"}}}}')).toThrow()
  expect(() => make('{"name":"defaulted_binding","authorization":"policy","create":{"defaults":{"ownerId":"owner"},"fromSubject":{"ownerId":{"_tag":"SubjectField","field":"userId"}}}}')).toThrow()
  expect(() => make('{"name":"generated_binding","authorization":"policy","create":{"generated":{"ownerId":"uuidV7"},"fromSubject":{"ownerId":{"_tag":"SubjectField","field":"userId"}}}}')).toThrow()
})


const PublicationSchema = Schema.Struct({ id: identifier(Schema.String), state: Schema.Literals(["draft", "published"]), title: Schema.String })
interface Publication extends Schema.Schema.Type<typeof PublicationSchema> {}
const q = Authorization.for({ resource: PublicationSchema, subject: SubjectSchema })
const published = q.eq(q.row.state, "published")
const publisher = q.includes(q.subject.roles, "publisher")
const publicationPolicy = q.policy({ scope: unrestricted, allow: { read: published, create: publisher, patch: publisher } })

const Publications = Resource.make({
  name: "authorized_publications", schema: PublicationSchema, operations: Resource.crud, authorization: publicationPolicy,
})

it.effect("write permission cannot expose an unreadable candidate and missing action rules deny", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([Publications.table])
    const subject = SubjectSchema.make({ ...alice, roles: ["publisher"] })
    const asPublisher = Effect.provideService(AuthorizationSubject, subject)
    const draft = yield* pipe(Publications.repository.create({ id: "draft", state: "draft", title: "hidden" }), asPublisher, rejectedTag)
    expect(draft).toBe("Forbidden")
    const visible = yield* pipe(Publications.repository.create({ id: "published", state: "published", title: "visible" }), asPublisher)
    const hide = yield* pipe(Publications.repository.patch(visible.id, { state: "draft" }), asPublisher, rejectedTag)
    expect(hide).toBe("Forbidden")
    const remove = yield* pipe(Publications.repository.remove(visible.id), asPublisher, rejectedTag)
    expect(remove).toBe("Forbidden")
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`SELECT id, state FROM authorized_publications ORDER BY id`
    expect(rows).toEqual([{ id: "published", state: "published" }])
  }), Effect.provide(sqlite),
))

const transferPolicy = p.policy({ scope, allow: { read: unrestricted, create: ownedCandidate, update: owned } })

const Transfers = Resource.make({
  name: "authorized_transfers", schema: OwnedDocumentSchema, operations: [], authorization: transferPolicy,
})

const failureTag = <A, E extends { readonly _tag: string }>(result: Result.Result<A, E>) =>
  Result.isFailure(result) ? result.failure._tag : "Success"

it.effect("concurrent transfers cannot both authorize against the previous owner", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([Transfers.table])
    const initial = yield* pipe(Transfers.repository.create({ id: "transfer", tenantId: "a", ownerId: "alice", title: "transfer" }), asAlice)
    const store = yield* RepositoryStore

    const interleavedStore = RepositoryStore.of({
      ...store,
      find: (table, key, access) => pipe(store.find(table, key, access), Effect.tap(() => Effect.yieldNow)),
    })

    const bobTransfer = pipe(Transfers.repository.update({ ...initial, ownerId: "bob" }), Effect.result)
    const carolTransfer = pipe(Transfers.repository.update({ ...initial, ownerId: "carol" }), Effect.result)
    const changes = Effect.all([bobTransfer, carolTransfer], { concurrency: 2 })
    const results = yield* pipe(changes, Effect.provideService(RepositoryStore, interleavedStore), asAlice)
    const outcomes = pipe(results, Array.map(failureTag), Array.sort(Order.String))
    expect(outcomes).toEqual(["Forbidden", "Success"])
    const final = yield* pipe(Transfers.repository.get(initial.id), asAlice)
    const success = yield* pipe(Array.findFirst(results, Result.isSuccess), Effect.fromOption)
    expect(final.ownerId).toBe(success.success.ownerId)
  }), Effect.provide(sqlite),
))

const FeaturePermissionSchema = Schema.Struct({ id: identifier(Schema.String), enabled: Schema.NullOr(Schema.Boolean) })
interface FeaturePermission extends Schema.Schema.Type<typeof FeaturePermissionSchema> {}

const FeatureSubjectSchema = Schema.Struct({
  enabled: Schema.NullOr(Schema.Boolean),
  enabledValues: Schema.Array(Schema.NullOr(Schema.Boolean)),
})

interface FeatureSubject extends Schema.Schema.Type<typeof FeatureSubjectSchema> {}

const flags = Authorization.for({ resource: FeaturePermissionSchema, subject: FeatureSubjectSchema })
const enabled = flags.eq(flags.row.enabled, flags.subject.enabled)
const enabledBySubject = flags.includes(flags.subject.enabledValues, flags.row.enabled)
const featureScope = flags.all()
const featureRead = flags.all(enabled, enabledBySubject)
const featurePermission = flags.policy({ scope: featureScope, allow: { read: featureRead } })

const FeaturePermissions = Resource.make({
  name: "feature_permissions",
  schema: FeaturePermissionSchema,
  authorization: featurePermission,
  operations: ["list"],
  list: { order: [{ field: "id" }], limit: 1 },
})

const enabledSubject = FeatureSubjectSchema.make({ enabled: true, enabledValues: [true] })
const nullSubject = FeatureSubjectSchema.make({ enabled: null, enabledValues: [null] })
const asEnabled = Effect.provideService(AuthorizationSubject, enabledSubject)
const asNull = Effect.provideService(AuthorizationSubject, nullSubject)

it.effect("native Boolean storage preserves equality, membership, subject, and null semantics before pagination", () => pipe(
  Effect.gen(function* () {
    const permittedRow = FeaturePermissionSchema.make({ id: "feature", enabled: true })

    const permitted = AuthorizationValues.make({
      row: Option.some(permittedRow),
      next: Option.none(),
    })

    yield* pipe(Authorization.require(featurePermission, "read", permitted), asEnabled)

    const withheldRow = FeaturePermissionSchema.make({ id: "feature", enabled: false })

    const withheld = AuthorizationValues.make({
      row: Option.some(withheldRow),
      next: Option.none(),
    })

    const denied = yield* pipe(Authorization.require(featurePermission, "read", withheld), asEnabled, rejectedTag)
    expect(denied).toBe("Forbidden")

    yield* prepareTables([FeaturePermissions.table])
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO feature_permissions (id, enabled) VALUES ('disabled', 0), ('enabled', 1), ('unset', NULL)`
    const visible = yield* pipe(FeaturePermissions.repository.list(), asEnabled)
    expect(visible).toEqual([{ id: "enabled", enabled: true }])
    const page = yield* pipe(FeaturePermissions.repository.page({ limit: 1 }), asEnabled)
    expect(page).toEqual({ items: [{ id: "enabled", enabled: true }], nextCursor: null })
    const nullVisible = yield* pipe(FeaturePermissions.repository.list(), asNull)
    expect(nullVisible).toEqual([{ id: "unset", enabled: null }])
  }),
  Effect.provide(sqlite),
))

it.effect("policy construction snapshots compiled rules and rejects fabricated policy descriptors", () => pipe(
  Effect.gen(function* () {
    const malformed = JSON.parse('{"_tag":"Equal","left":{"_tag":"RowField","field":"ownerId"}}')
    const policyScope = p.all()
    expect(() => p.policy({ scope: policyScope, allow: { read: malformed } })).toThrow()

    const rule = p.eq(p.row.ownerId, p.subject.userId)
    const rules = FabricatedPolicyShapeSchema.fields.allow.make({ read: rule })
    const compiled = p.policy({ scope: policyScope, allow: rules })
    const compiledRow = OwnedDocumentSchema.make({ id: "owned", tenantId: "a", ownerId: "alice", title: "private" })

    const compiledValues = AuthorizationValues.make({
      row: Option.some(compiledRow),
      next: Option.none(),
    })

    yield* pipe(Authorization.require(compiled, "read", compiledValues), asAlice)
    const alwaysAllowed = Policy.constant(true)
    yield* Effect.sync(() => Reflect.set(rules, "read", alwaysAllowed))
    const stillDenied = yield* pipe(Authorization.require(compiled, "read", compiledValues), asBob, rejectedTag)
    expect(stillDenied).toBe("Forbidden")
    const copied = Struct.assign(compiled, { allow: { read: alwaysAllowed } })
    const copiedDenied = yield* pipe(Authorization.require(copied, "read", compiledValues), asBob, rejectedTag)
    expect(copiedDenied).toBe("AuthorizationDefinitionError")
    const fabricatedRead = Policy.constant(true)
    const fabricatedScope = Policy.constant(true)

    const fabricated = FabricatedPolicySchema.make({
      resource: OwnedDocumentSchema,
      subject: SubjectSchema,
      scope: fabricatedScope,
      allow: { read: fabricatedRead },
    })

    const fabricatedRow = OwnedDocumentSchema.make({ id: "owned", tenantId: "a", ownerId: "alice", title: "private" })

    const fabricatedValues = AuthorizationValues.make({
      row: Option.some(fabricatedRow),
      next: Option.none(),
    })

    const rejected = yield* pipe(Authorization.require(fabricated, "read", fabricatedValues), asAlice, rejectedTag)
    expect(rejected).toBe("AuthorizationDefinitionError")
  }),
))
