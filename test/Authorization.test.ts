import { expect, it } from "@effect/vitest"
import { Array, Data, Effect, Equivalence, Option, Order, Result, Schema, Struct, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Authorization } from "effect-domains/authorization"
import { AuthorizationSubject, AuthorizationValues, type PolicyAuthorization } from "effect-domains/authorization-model"
import { identifier } from "effect-domains/domain"
import { Resource } from "effect-domains/resource"
import { Transitions } from "effect-domains/transitions"
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


const FabricatedPolicyDescriptorSchema = Schema.TaggedStruct("Policy", {
  resource: Schema.Unknown,
  subject: Schema.Unknown,
  scope: Policy.Schema,
  allow: Schema.Record(Schema.String, Policy.Schema),
})

const FabricatedPolicySchema = Schema.make<Schema.Codec<PolicyAuthorization>>(FabricatedPolicyDescriptorSchema.ast)

const UnsafeResourceSourcesSchema = Schema.Record(Schema.String, Schema.Unknown)

class UnsafeResourceDefinition extends Schema.Class<UnsafeResourceDefinition>("UnsafeResourceDefinition")({
  name: Schema.String,
  authorization: Schema.Unknown,
  sources: UnsafeResourceSourcesSchema,
}) {}

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

const documentCreateSources = {
  tenantId: Resource.fromSubject(p.subject.tenantId),
  ownerId: Resource.fromSubject(p.subject.userId),
}

const documentCapabilities = [
  Resource.get(),
  Resource.list({ filter: ["ownerId"], limit: 2 }),
  Resource.create({ sources: documentCreateSources }),
  Resource.update(),
  Resource.remove(),
  Resource.patch(),
]

const Documents = Resource.define({
  name: "authorized_documents", schema: OwnedDocumentSchema, authorization: policy,
  capabilities: documentCapabilities,
})

const documentsTable = Resource.table(Documents)

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
  yield* prepareTables([documentsTable])

  const sql = yield* SqlClient.SqlClient

  yield* sql`INSERT INTO authorized_documents (id, tenantId, ownerId, title) VALUES
    ('1', 'a', 'alice', 'alpha'), ('2', 'a', 'bob', 'bravo'),
    ('3', 'b', 'eve', 'charlie'), ('4', 'a', 'alice', 'delta')`
})

it.effect("subject policies snapshot allowed values and reject invalid claims and resource-dependent rules", Effect.fn("Authorization.subjectPolicy")(function* () {
  const subject = Authorization.subject(SubjectSchema)
  const allowedUsers = ["alice"]
  const allowed = subject.includes(allowedUsers, subject.subject.userId)
  const policy = subject.policy(allowed)

  yield* Effect.sync(() => Reflect.set(allowedUsers, "0", "bob"))

  const admitted = yield* pipe(Authorization.requireSubject(policy), asAlice)

  expect(admitted.userId).toBe("alice")

  const denied = yield* pipe(Authorization.requireSubject(policy), asBob, rejectedTag)

  expect(denied).toBe("Forbidden")

  const invalid = yield* pipe(
    Authorization.requireSubject(policy),
    Effect.provideService(AuthorizationSubject, { userId: "alice", tenantId: "a", roles: "admin" }),
    rejectedTag,
  )

  expect(invalid).toBe("Forbidden")
  expect(() => subject.policy(owned as never)).toThrow()
}))

it.effect("sameAs compares a shared resource and subject field", Effect.fn("Authorization.sameAs")(function* () {
  const sharedTenant = p.sameAs("tenantId")
  const unrestrictedScope = p.all()
  const sameTenantPolicy = p.policy({ scope: unrestrictedScope, allow: { read: sharedTenant } })
  const row = OwnedDocumentSchema.make({ id: "same-tenant", tenantId: "a", ownerId: "eve", title: "shared" })
  const currentRow = Option.some(row)
  const absentNext = Option.none()
  const values = new AuthorizationValues({ row: currentRow, next: absentNext })
  const otherTenant = SubjectSchema.make({ userId: "eve", tenantId: "b", roles: [] })

  const denied = yield* pipe(
    Authorization.require(sameTenantPolicy, "read", values),
    Effect.provideService(AuthorizationSubject, otherTenant),
    rejectedTag,
  )

  expect(denied).toBe("Forbidden")
}))

it.effect("repository visibility scopes identifiers and pagination before computing continuations", () => pipe(
  Effect.gen(function* () {
    yield* seed

    const unauthenticated = yield* pipe(Resource.repository(Documents).get("1"), rejectedTag)

    expect(unauthenticated).toBe("Unauthenticated")

    const invalidSubject = yield* pipe(Resource.repository(Documents).get("1"), Effect.provideService(AuthorizationSubject, { userId: "alice" }), rejectedTag)

    expect(invalidSubject).toBe("Unauthenticated")

    const hidden = yield* pipe(Resource.repository(Documents).find("2"), asAlice, Effect.map(Option.isNone))

    expect(hidden).toBe(true)

    const missing = yield* pipe(Resource.repository(Documents).get("absent"), asAlice, rejectedTag)
    const forbidden = yield* pipe(Resource.repository(Documents).get("2"), asAlice, rejectedTag)

    expect(forbidden).toBe(missing)
    expect(forbidden).toBe("ResourceNotFound")

    const tenantBoundary = yield* pipe(Resource.repository(Documents).get("3"), asAdmin, rejectedTag)

    expect(tenantBoundary).toBe("ResourceNotFound")

    const visible = yield* pipe(Resource.repository(Documents).list(), asAlice, Effect.map(Struct.get("items")), Effect.map(documentIds), Effect.map(Array.sort(Order.String)))

    expect(visible).toEqual(["1", "4"])

    const first = yield* pipe(Resource.repository(Documents).list({ limit: 1 }), asAlice)
    const firstIds = documentIds(first.items)

    expect(firstIds).toEqual(["1"])

    const cursor = yield* Effect.fromNullishOr(first.nextCursor)
    const second = yield* pipe(Resource.repository(Documents).list({ limit: 1, cursor }), asAlice)
    const secondIds = documentIds(second.items)

    expect(secondIds).toEqual(["4"])
    expect(second.nextCursor).toBeNull()

    const replay = yield* pipe(Resource.repository(Documents).list({ limit: 2, cursor }), asBob)
    const replayIds = documentIds(replay.items)

    expect(replayIds).toEqual(["2"])
    expect(replay.nextCursor).toBeNull()

    const filtered = yield* pipe(Resource.repository(Documents).list({ filter: { ownerId: "bob" } }), asAlice)

    expect(filtered).toEqual({ items: [], nextCursor: null })

    const privileged = yield* pipe(Resource.repository(Documents).list({ limit: 1 }), asAdmin)
    const privilegedCursor = yield* Effect.fromNullishOr(privileged.nextCursor)
    const revoked = yield* pipe(Resource.repository(Documents).list({ cursor: privilegedCursor }), Effect.provideService(AuthorizationSubject, { ...admin, roles: [] }))

    expect(revoked).toEqual({ items: [], nextCursor: null })
  }), Effect.provide(sqlite),
))

it.effect("create update patch and remove enforce current and candidate authorization without partial writes", () => pipe(
  Effect.gen(function* () {
    yield* seed

    const forged = yield* pipe(
      Resource.repository(Documents).create({ id: "5", tenantId: "a", ownerId: "bob", title: "forged" } as never),
      asAlice,
      rejectedTag,
    )

    expect(forged).toBe("RepositoryError")

    const crossTenant = yield* pipe(
      Resource.repository(Documents).create({ id: "6", tenantId: "b", title: "cross" } as never),
      asAlice,
      rejectedTag,
    )

    expect(crossTenant).toBe("RepositoryError")

    const original = yield* pipe(Resource.repository(Documents).get("1"), asAlice)
    const transfer = yield* pipe(Resource.repository(Documents).update({ ...original, ownerId: "bob" }), asAdmin, rejectedTag)

    expect(transfer).toBe("Forbidden")

    const move = yield* pipe(Resource.repository(Documents).patch("1", { tenantId: "b" }), asAdmin, rejectedTag)

    expect(move).toBe("Forbidden")

    const hiddenPatch = yield* pipe(Resource.repository(Documents).patch("2", { ownerId: "alice" }), asAlice, rejectedTag)

    expect(hiddenPatch).toBe("ResourceNotFound")

    const hiddenDelete = yield* pipe(Resource.repository(Documents).remove("3"), asAdmin, rejectedTag)

    expect(hiddenDelete).toBe("ResourceNotFound")

    const unchanged = yield* pipe(Resource.repository(Documents).get("1"), asAlice)

    expect(unchanged).toEqual(original)

    const created = yield* pipe(Resource.repository(Documents).create({ id: "7", title: "new" }), asAlice)

    expect(created).toMatchObject({ id: "7", tenantId: "a", ownerId: "alice" })

    const changed = yield* pipe(Resource.repository(Documents).patch("7", { title: "changed" }), asAlice)

    expect(changed.title).toBe("changed")
    yield* pipe(Resource.repository(Documents).remove("7"), asAlice)

    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<Pick<OwnedDocument, "id">>`SELECT id FROM authorized_documents ORDER BY id`
    const ids = Array.map(rows, Struct.get("id"))

    expect(ids).toEqual(["1", "2", "3", "4"])
  }), Effect.provide(sqlite),
))

it("rejects unsafe create subject binding definitions", () => {
  const authorizationFrom = (authorization: unknown) => {
    if (typeof authorization !== "string") return authorization

    return Equivalence.strictEqual<string>()(authorization, "policy") ? policy : authorization
  }

  const compileUnsafe = (definition: UnsafeResourceDefinition) => {
    const authorization = authorizationFrom(definition.authorization)
    const createCapability = new Data.Class({ _tag: "Create", sources: definition.sources })

    const resourceDefinition = new Data.Class({
      name: definition.name,
      authorization,
      schema: OwnedDocumentSchema,
      capabilities: [createCapability],
    })

    const spec = Reflect.apply(Resource.define, null, [resourceDefinition])

    return Resource.compile(spec)
  }

  const subject = (field: string) => {
    const operand = new Data.Class({ _tag: "SubjectField", field })

    return new Data.Class({ _tag: "Subject", operand })
  }

  const userSubject = subject("userId")
  const absentSubject = subject("absent")
  const rolesSubject = subject("roles")
  const publicSources = new Data.Class<Record<string, unknown>>({ ownerId: userSubject })
  const denySources = new Data.Class<Record<string, unknown>>({ ownerId: userSubject })
  const unknownTargetSources = new Data.Class<Record<string, unknown>>({ absent: userSubject })
  const rowOperand = new Data.Class({ _tag: "RowField", field: "ownerId" })
  const rowSubject = new Data.Class({ _tag: "Subject", operand: rowOperand })
  const nonSubjectSources = new Data.Class<Record<string, unknown>>({ ownerId: rowSubject })
  const unknownSubjectSources = new Data.Class<Record<string, unknown>>({ ownerId: absentSubject })
  const incompatibleSources = new Data.Class<Record<string, unknown>>({ ownerId: rolesSubject })

  const publicBinding = UnsafeResourceDefinition.make({
    name: "public_binding",
    authorization: Authorization.public,
    sources: publicSources,
  })

  const denyBinding = UnsafeResourceDefinition.make({
    name: "deny_binding",
    authorization: Authorization.deny,
    sources: denySources,
  })

  const unknownTargetBinding = UnsafeResourceDefinition.make({
    name: "unknown_target_binding",
    authorization: "policy",
    sources: unknownTargetSources,
  })

  const nonSubjectBinding = UnsafeResourceDefinition.make({
    name: "non_subject_binding",
    authorization: "policy",
    sources: nonSubjectSources,
  })

  const unknownSubjectBinding = UnsafeResourceDefinition.make({
    name: "unknown_subject_binding",
    authorization: "policy",
    sources: unknownSubjectSources,
  })

  const incompatibleBinding = UnsafeResourceDefinition.make({
    name: "incompatible_binding",
    authorization: "policy",
    sources: incompatibleSources,
  })

  expect(() => compileUnsafe(publicBinding)).toThrow()
  expect(() => compileUnsafe(denyBinding)).toThrow()
  expect(() => compileUnsafe(unknownTargetBinding)).toThrow()
  expect(() => compileUnsafe(nonSubjectBinding)).toThrow()
  expect(() => compileUnsafe(unknownSubjectBinding)).toThrow()
  expect(() => compileUnsafe(incompatibleBinding)).toThrow()
})

it.effect("populates nullable resource fields from required subject fields", () => pipe(
  Effect.gen(function* () {
    const NullableOwnerSchema = Schema.Struct({
      id: identifier(Schema.String),
      ownerId: Schema.NullOr(Schema.String),
    })

    interface NullableOwner extends Schema.Schema.Type<typeof NullableOwnerSchema> {}

    const nullableOwner = Authorization.for({ resource: NullableOwnerSchema, subject: SubjectSchema })
    const all = nullableOwner.all()
    const policy = nullableOwner.policy({ scope: all, allow: { create: all, read: all } })
    const nullableOwnerSource = Resource.fromSubject(nullableOwner.subject.userId)
    const nullableOwnerSources = Object.freeze({ ownerId: nullableOwnerSource })

    const nullableOwnerCapabilities = [Resource.create({
      sources: nullableOwnerSources,
      publish: false,
    })]

    const resource = Resource.define({
      name: "nullable_owner_subject_binding",
      schema: NullableOwnerSchema,
      authorization: policy,
      capabilities: nullableOwnerCapabilities,
    })

    const nullableOwnerTable = Resource.table(resource)

    yield* prepareTables([nullableOwnerTable])

    const created = yield* pipe(Resource.repository(resource).create({ id: "bound" }), asAlice)

    expect(created.ownerId).toBe("alice")
  }),
  Effect.provide(sqlite),
))

it("rejects nullable subject fields bound to required resource fields", () => {
  const NullableOwnerSubjectSchema = Schema.Struct({
    userId: Schema.NullOr(Schema.String),
    tenantId: Schema.String,
    roles: Schema.Array(Schema.String),
  })

  interface NullableOwnerSubject extends Schema.Schema.Type<typeof NullableOwnerSubjectSchema> {}

  const nullableOwnerSubject = Authorization.for({ resource: OwnedDocumentSchema, subject: NullableOwnerSubjectSchema })
  const all = nullableOwnerSubject.all()
  const policy = nullableOwnerSubject.policy({ scope: all, allow: { create: all } })
  const requiredOwnerSource = Resource.fromSubject(nullableOwnerSubject.subject.userId)
  const requiredOwnerSources = Object.freeze({ ownerId: requiredOwnerSource })

  const requiredOwnerCapabilities = [Resource.create({
    sources: requiredOwnerSources,
    publish: false,
  })]

  const definition = new Data.Class({
    name: "required_owner_subject_binding",
    schema: OwnedDocumentSchema,
    authorization: policy,
    capabilities: requiredOwnerCapabilities,
  })

  const spec = Reflect.apply(Resource.define, null, [definition])

  expect(() => Resource.compile(spec)).toThrow()
})


const PublicationSchema = Schema.Struct({ id: identifier(Schema.String), state: Schema.Literals(["draft", "published"]), title: Schema.String })

interface Publication extends Schema.Schema.Type<typeof PublicationSchema> {}

const q = Authorization.for({ resource: PublicationSchema, subject: SubjectSchema })
const published = q.eq(q.row.state, "published")
const publisher = q.includes(q.subject.roles, "publisher")
const publicationPolicy = q.policy({ scope: unrestricted, allow: { read: published, create: publisher, patch: publisher } })

const publicationCapabilities = Resource.crud()

const Publications = Resource.define({ name: "authorized_publications", schema: PublicationSchema, capabilities: publicationCapabilities, authorization: publicationPolicy })

const publicationsTable = Resource.table(Publications)

it.effect("write permission cannot expose an unreadable candidate and missing action rules deny", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([publicationsTable])

    const subject = SubjectSchema.make({ ...alice, roles: ["publisher"] })
    const asPublisher = Effect.provideService(AuthorizationSubject, subject)
    const draft = yield* pipe(Resource.repository(Publications).create({ id: "draft", state: "draft", title: "hidden" }), asPublisher, rejectedTag)

    expect(draft).toBe("Forbidden")

    const visible = yield* pipe(Resource.repository(Publications).create({ id: "published", state: "published", title: "visible" }), asPublisher)
    const hide = yield* pipe(Resource.repository(Publications).patch(visible.id, { state: "draft" }), asPublisher, rejectedTag)

    expect(hide).toBe("Forbidden")

    const remove = yield* pipe(Resource.repository(Publications).remove(visible.id), asPublisher, rejectedTag)

    expect(remove).toBe("Forbidden")

    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`SELECT id, state FROM authorized_publications ORDER BY id`

    expect(rows).toEqual([{ id: "published", state: "published" }])
  }), Effect.provide(sqlite),
))

const transferPolicy = p.policy({ scope, allow: { read: unrestricted, create: ownedCandidate, update: owned } })

const transferCapabilities: ReadonlyArray<never> = []

const Transfers = Resource.define({ name: "authorized_transfers", schema: OwnedDocumentSchema, capabilities: transferCapabilities, authorization: transferPolicy })

const transfersTable = Resource.table(Transfers)

const failureTag = <A, E extends { readonly _tag: string }>(result: Result.Result<A, E>) =>
  Result.isFailure(result) ? result.failure._tag : "Success"

it.effect("concurrent transfers cannot both authorize against the previous owner", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([transfersTable])

    const initial = yield* pipe(Resource.repository(Transfers).create({ id: "transfer", tenantId: "a", ownerId: "alice", title: "transfer" }), asAlice)
    const store = yield* RepositoryStore

    const interleavedStore = RepositoryStore.of({
      ...store,
      select: (table, selection, access) => pipe(store.select(table, selection, access), Effect.tap(() => Effect.yieldNow)),
    })

    const bobTransfer = pipe(Resource.repository(Transfers).update({ ...initial, ownerId: "bob" }), Effect.result)
    const carolTransfer = pipe(Resource.repository(Transfers).update({ ...initial, ownerId: "carol" }), Effect.result)
    const changes = Effect.all([bobTransfer, carolTransfer], { concurrency: 2 })
    const results = yield* pipe(changes, Effect.provideService(RepositoryStore, interleavedStore), asAlice)
    const outcomes = pipe(results, Array.map(failureTag), Array.sort(Order.String))

    expect(outcomes).toEqual(["Forbidden", "Success"])

    const final = yield* pipe(Resource.repository(Transfers).get(initial.id), asAlice)
    const success = yield* pipe(Array.findFirst(results, Result.isSuccess), Effect.fromOption)

    expect(final.ownerId).toBe(success.success.ownerId)
  }), Effect.provide(sqlite),
))

const AuthorizedTransitionStatusSchema = Schema.Literals(["draft", "published"])

const AuthorizedTransitions = Transitions.make({
  name: "AuthorizedPublication",
  field: "state",
  status: AuthorizedTransitionStatusSchema,
  transitions: { publish: { from: ["draft"], to: "published" } },
})

const AuthorizedTransitionSchema = Schema.Struct({
  id: identifier(Schema.String),
  state: AuthorizedTransitionStatusSchema,
})

const transitionPolicyDsl = Authorization.for({ resource: AuthorizedTransitionSchema, subject: SubjectSchema })
const transitionPublisher = transitionPolicyDsl.includes(transitionPolicyDsl.subject.roles, "publisher")
const transitionScope = transitionPolicyDsl.all()

const authorizedTransitionPolicy = transitionPolicyDsl.policy({
  scope: transitionScope,
  allow: { read: transitionPublisher, transition: transitionPublisher },
})

const authorizedTransitionCapabilities = [Resource.transition()]

const AuthorizedTransitionResource = Resource.define({
  name: "authorized_transitions",
  schema: AuthorizedTransitionSchema,
  authorization: authorizedTransitionPolicy,
  transitions: AuthorizedTransitions,
  capabilities: authorizedTransitionCapabilities,
})

const authorizedTransitionTable = Resource.table(AuthorizedTransitionResource)

it.effect("transitions use their own authorization action rather than patch permission", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([authorizedTransitionTable])

    const sql = yield* SqlClient.SqlClient

    yield* sql`INSERT INTO authorized_transitions (id, state) VALUES ('publication', 'draft')`

    const subject = SubjectSchema.make({ userId: "publisher", tenantId: "a", roles: ["publisher"] })

    const published = yield* pipe(
      Resource.repository(AuthorizedTransitionResource).transition("publication", "publish"),
      Effect.provideService(AuthorizationSubject, subject),
    )

    expect(published).toEqual({ id: "publication", state: "published" })
  }),
  Effect.provide(sqlite),
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

const featurePermissionCapabilities = [Resource.list({ limit: 1 })]

const FeaturePermissions = Resource.define({
  name: "feature_permissions",
  schema: FeaturePermissionSchema,
  authorization: featurePermission,
  capabilities: featurePermissionCapabilities,
})

const featurePermissionsTable = Resource.table(FeaturePermissions)

const enabledSubject = FeatureSubjectSchema.make({ enabled: true, enabledValues: [true] })
const nullSubject = FeatureSubjectSchema.make({ enabled: null, enabledValues: [null] })
const asEnabled = Effect.provideService(AuthorizationSubject, enabledSubject)
const asNull = Effect.provideService(AuthorizationSubject, nullSubject)
const absent = Option.none()

it.effect("native Boolean storage preserves equality, membership, subject, and null semantics before pagination", () => pipe(
  Effect.gen(function* () {
    const permittedRow = FeaturePermissionSchema.make({ id: "feature", enabled: true })
    const permittedPresent = Option.some(permittedRow)
    const permitted = new AuthorizationValues({ row: permittedPresent, next: absent })

    yield* pipe(Authorization.require(featurePermission, "read", permitted), asEnabled)

    const withheldRow = FeaturePermissionSchema.make({ id: "feature", enabled: false })
    const withheldPresent = Option.some(withheldRow)
    const withheld = new AuthorizationValues({ row: withheldPresent, next: absent })
    const denied = yield* pipe(Authorization.require(featurePermission, "read", withheld), asEnabled, rejectedTag)

    expect(denied).toBe("Forbidden")

    yield* prepareTables([featurePermissionsTable])

    const sql = yield* SqlClient.SqlClient

    yield* sql`INSERT INTO feature_permissions (id, enabled) VALUES ('disabled', 0), ('enabled', 1), ('unset', NULL)`

    const visible = yield* pipe(Resource.repository(FeaturePermissions).list(), asEnabled)

    expect(visible).toEqual({ items: [{ id: "enabled", enabled: true }], nextCursor: null })

    const page = yield* pipe(Resource.repository(FeaturePermissions).list({ limit: 1 }), asEnabled)

    expect(page).toEqual({ items: [{ id: "enabled", enabled: true }], nextCursor: null })

    const nullVisible = yield* pipe(Resource.repository(FeaturePermissions).list(), asNull)

    expect(nullVisible).toEqual({ items: [{ id: "unset", enabled: null }], nextCursor: null })
  }),
  Effect.provide(sqlite),
))

it.effect("policy construction snapshots compiled rules and rejects fabricated policy descriptors", () => pipe(
  Effect.gen(function* () {
    const malformed = JSON.parse('{"_tag":"Equal","left":{"_tag":"RowField","field":"ownerId"}}')
    const policyScope = p.all()

    expect(() => p.policy({ scope: policyScope, allow: { read: malformed } })).toThrow()

    const rule = p.eq(p.row.ownerId, p.subject.userId)
    const rules = FabricatedPolicyDescriptorSchema.fields.allow.make({ read: rule })
    const compiled = p.policy({ scope: policyScope, allow: rules })
    const compiledRow = OwnedDocumentSchema.make({ id: "owned", tenantId: "a", ownerId: "alice", title: "private" })
    const compiledValuesPresent = Option.some(compiledRow)
    const compiledValues = new AuthorizationValues({ row: compiledValuesPresent, next: absent })

    yield* pipe(Authorization.require(compiled, "read", compiledValues), asAlice)

    const clone = Struct.assign(compiled, {})
    const cloneDenied = yield* pipe(Authorization.require(clone, "read", compiledValues), asAlice, rejectedTag)

    expect(cloneDenied).toBe("AuthorizationDefinitionError")

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
    const fabricatedValuesPresent = Option.some(fabricatedRow)
    const fabricatedValues = new AuthorizationValues({ row: fabricatedValuesPresent, next: absent })
    const rejected = yield* pipe(Authorization.require(fabricated, "read", fabricatedValues), asAlice, rejectedTag)

    expect(rejected).toBe("AuthorizationDefinitionError")
  }),
))
