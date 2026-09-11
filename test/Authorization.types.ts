import { Schema } from "effect"
import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"

const ScoredDocumentSchema = Schema.Struct({ tenantId: Schema.String, ownerId: Schema.String, score: Schema.Int })
interface ScoredDocument extends Schema.Schema.Type<typeof ScoredDocumentSchema> {}
const PolicyAuthorSchema = Schema.Struct({ userId: Schema.String, tenantId: Schema.String, roles: Schema.Array(Schema.String) })
interface PolicyAuthor extends Schema.Schema.Type<typeof PolicyAuthorSchema> {}
const p = Authorization.for({ resource: ScoredDocumentSchema, subject: PolicyAuthorSchema })
const scope = p.eq(p.row.tenantId, p.subject.tenantId)
const owned = p.eq(p.row.ownerId, p.subject.userId)
const candidateOwned = p.eq(p.next.ownerId, p.subject.userId)
const unchanged = p.unchanged("ownerId")

const sharedTenant = p.sameAs("tenantId")
void sharedTenant
const policy = p.policy({ scope, allow: { read: owned, create: candidateOwned, patch: unchanged } })
Resource.make({ name: "typed_authorization", schema: ScoredDocumentSchema, authorization: policy, operations: { get: true } })

const BoundDocument = Resource.make({
  name: "subject_bound_authorization",
  schema: ScoredDocumentSchema,
  authorization: policy,
  operations: { create: { fromSubject: { tenantId: p.subject.tenantId, ownerId: p.subject.userId } } },
})

const boundCreate: Parameters<typeof BoundDocument.repository.create>[0] = { score: 1 }
void boundCreate

// @ts-expect-error because subject-bound fields are not caller-controlled.
const forgedBoundCreate: Parameters<typeof BoundDocument.repository.create>[0] = { score: 1, ownerId: "forged" }
void forgedBoundCreate
// @ts-expect-error because subject bindings must have the destination field's type.
Resource.make({ name: "invalid_subject_binding_type", schema: ScoredDocumentSchema, authorization: policy, operations: { create: { fromSubject: { score: p.subject.userId }, publish: false } } })
// @ts-expect-error because public resources do not have a verified subject.
Resource.make({ name: "public_subject_binding", schema: ScoredDocumentSchema, authorization: Authorization.public, operations: { create: { fromSubject: { ownerId: p.subject.userId }, publish: false } } })

const NullableOwnerDocumentSchema = Schema.Struct({ tenantId: Schema.String, ownerId: Schema.NullOr(Schema.String), score: Schema.Int })
interface NullableOwnerDocument extends Schema.Schema.Type<typeof NullableOwnerDocumentSchema> {}

const nullableOwner = Authorization.for({ resource: NullableOwnerDocumentSchema, subject: PolicyAuthorSchema })
const nullableOwnerAll = nullableOwner.all()
const nullableOwnerPolicy = nullableOwner.policy({ scope: nullableOwnerAll, allow: { create: nullableOwnerAll } })

Resource.make({
  name: "nullable_subject_binding_target",
  schema: NullableOwnerDocumentSchema,
  authorization: nullableOwnerPolicy,
  operations: { create: { fromSubject: { ownerId: nullableOwner.subject.userId }, publish: false } },
})

const NullableBindingIdentitySchema = Schema.Struct({ userId: Schema.NullOr(Schema.String) })
interface NullableBindingIdentity extends Schema.Schema.Type<typeof NullableBindingIdentitySchema> {}

const nullableOwnerSubject = Authorization.for({ resource: ScoredDocumentSchema, subject: NullableBindingIdentitySchema })
const nullableOwnerSubjectAll = nullableOwnerSubject.all()
const nullableOwnerSubjectPolicy = nullableOwnerSubject.policy({ scope: nullableOwnerSubjectAll, allow: { create: nullableOwnerSubjectAll } })

// @ts-expect-error because a nullable subject field cannot populate a required destination.
Resource.make({ name: "nullable_subject_binding_source", schema: ScoredDocumentSchema, authorization: nullableOwnerSubjectPolicy, operations: { create: { fromSubject: { ownerId: nullableOwnerSubject.subject.userId }, publish: false } } })

// These probes are compile-only because rejected definitions intentionally fail at runtime.
// @ts-expect-error Because authorization must be an explicit application choice.
Resource.make({ name: "implicit_access", schema: ScoredDocumentSchema, operations: {} })
// @ts-expect-error Because unknown fields cannot become policy references.
p.row.absent
// @ts-expect-error Because equality cannot compare numeric resource values with subject strings.
p.eq(p.row.score, p.subject.userId)
// @ts-expect-error Because membership must compare the element type of the collection.
p.includes(p.subject.roles, p.row.score)
// @ts-expect-error Because a read policy cannot reference the candidate state.
p.policy({ scope, allow: { read: candidateOwned } })
// @ts-expect-error Because creation has no current resource state.
p.policy({ scope, allow: { create: owned } })
// @ts-expect-error Because scope must apply independently to current and candidate state.
p.policy({ scope: unchanged, allow: { read: owned } })

const subject = Authorization.subject(PolicyAuthorSchema)
const editorRole = subject.includes(subject.subject.roles, "editor")
const canEdit = subject.policy(editorRole)
p.policy({ scope: canEdit, allow: { read: canEdit } })
// @ts-expect-error Because a subject policy cannot depend on a current resource row.
subject.policy(owned)
// @ts-expect-error Because a subject policy cannot depend on a candidate resource row.
subject.policy(candidateOwned)
// @ts-expect-error Because a subject policy retains scalar membership checking.
subject.includes(subject.subject.roles, 1)

const LiteralRolesSchema = Schema.Struct({ roles: Schema.Array(Schema.Literals(["reader", "editor"])) })
const literalRoles = Authorization.subject(LiteralRolesSchema)
literalRoles.includes(literalRoles.subject.roles, "reader")
// @ts-expect-error Because a literal collection only includes members of its literal union.
literalRoles.includes(literalRoles.subject.roles, "adnim")
// @ts-expect-error Because sameAs requires a scalar field shared by the resource and subject schemas.
p.sameAs("score")
