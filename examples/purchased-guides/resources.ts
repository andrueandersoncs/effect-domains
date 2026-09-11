import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ExampleSubjectSchema } from "@effect-domains/example-support/subject"
import { GuidePurchaseSchema, GuideSchema } from "./domain.ts"

const policy = Authorization.for({ resource: GuideSchema, subject: ExampleSubjectSchema })
const tenantScope = policy.eq(policy.row.tenantId, policy.subject.tenantId)
const reader = policy.includes(policy.subject.roles, "reader")
const editor = policy.includes(policy.subject.roles, "editor")
const administrator = policy.includes(policy.subject.roles, "admin")
const guideReader = policy.any(reader, editor, administrator)
const guidePurchase = policy.entitlement({ name: "guides.read", key: policy.row.id })

const guideAuthorization = policy.policy({
  scope: tenantScope,
  allow: { read: guideReader },
  require: {
    read: [guidePurchase],
  },
})

export const GuidesResource = Resource.make({
  authorization: guideAuthorization,
  name: "guides",
  schema: GuideSchema,
  operations: { get: true, list: { limit: 25 } },
})

export const GuidePurchasesResource = Resource.make({
  authorization: Authorization.deny,
  name: "guide_purchases",
  schema: GuidePurchaseSchema,
  operations: {},
})
