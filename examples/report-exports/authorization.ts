import { Authorization } from "effect-domains/authorization"
import { ExampleSubjectSchema } from "@effect-domains/example-support/subject"

const policy = Authorization.subject(ExampleSubjectSchema)
const reportGenerator = policy.includes(policy.subject.roles, "editor")
const operator = policy.includes(policy.subject.roles, "admin")
const reportSubscription = policy.entitlement({ name: "reports.generate", key: policy.subject.tenantId })

export const ReportExportGenerationAuthorization = policy.policy(reportGenerator, {
  require: [reportSubscription],
})

export const ReportExportOperatorAuthorization = policy.policy(operator)
