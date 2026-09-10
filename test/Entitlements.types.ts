import { Schema } from "effect"
import { Authorization } from "effect-domains/authorization"

const ReportSchema = Schema.Struct({ id: Schema.String, tenantId: Schema.String, accountId: Schema.String })
const SubjectSchema = Schema.Struct({ tenantId: Schema.String, nullableTenantId: Schema.NullOr(Schema.String), numberId: Schema.Int })
const p = Authorization.for({ resource: ReportSchema, subject: SubjectSchema })
const access = p.all()
const report = p.entitlement({ name: "report", key: p.row.id })
const candidate = p.entitlement({ name: "report", key: p.next.id })
const account = p.entitlement({ name: "account", key: p.subject.tenantId })
const globalAccount = p.entitlement({ name: "account", key: "global" })

p.policy({
  scope: access,
  allow: { read: access, create: access, update: access },
  require: { read: [report], create: [account], update: [globalAccount] },
})

// @ts-expect-error because entitlement keys must resolve to strings.
p.entitlement({ name: "report", key: p.subject.numberId })
// @ts-expect-error because nullable keys cannot identify an entitlement.
p.entitlement({ name: "report", key: p.subject.nullableTenantId })
// @ts-expect-error because creation requirements cannot read the absent current row.
p.policy({ scope: access, allow: { create: access }, require: { create: [report] } })
// @ts-expect-error because read requirements cannot read the absent candidate row.
p.policy({ scope: access, allow: { read: access }, require: { read: [candidate] } })
// @ts-expect-error because requirements require a matching action policy.
p.policy({ scope: access, allow: { read: access }, require: { remove: [report] } })

const subject = Authorization.subject(SubjectSchema)
const subjectAccess = subject.all()
const subjectAccount = subject.entitlement({ name: "account", key: subject.subject.tenantId })
subject.policy(subjectAccess, { require: [subjectAccount] })
// @ts-expect-error because subject policies cannot require row-dependent entitlements.
subject.policy(subjectAccess, { require: [report] })
// @ts-expect-error because subject policies cannot require candidate-dependent entitlements.
subject.policy(subjectAccess, { require: [candidate] })
