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
const policy = p.policy({ scope, allow: { read: owned, create: candidateOwned, patch: unchanged } })
Resource.make({ name: "typed_authorization", schema: ScoredDocumentSchema, authorization: policy, operations: ["get"] })

const BoundDocument = Resource.make({
  name: "subject_bound_authorization",
  schema: ScoredDocumentSchema,
  authorization: policy,
  create: { fromSubject: { tenantId: p.subject.tenantId, ownerId: p.subject.userId } },
  operations: ["create"],
})

const boundCreate: Parameters<typeof BoundDocument.repository.create>[0] = { score: 1 }
void boundCreate

// @ts-expect-error because subject-bound fields are not caller-controlled.
const forgedBoundCreate: Parameters<typeof BoundDocument.repository.create>[0] = { score: 1, ownerId: "forged" }
void forgedBoundCreate
// @ts-expect-error because subject bindings must have the destination field's type.
Resource.make({ name: "invalid_subject_binding_type", schema: ScoredDocumentSchema, authorization: policy, create: { fromSubject: { score: p.subject.userId } }, operations: [] })
// @ts-expect-error because public resources do not have a verified subject.
Resource.make({ name: "public_subject_binding", schema: ScoredDocumentSchema, authorization: Authorization.public, create: { fromSubject: { ownerId: p.subject.userId } }, operations: [] })

// These probes are compile-only because rejected definitions intentionally fail at runtime.
// @ts-expect-error Because authorization must be an explicit application choice.
Resource.make({ name: "implicit_access", schema: ScoredDocumentSchema, operations: [] })
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
