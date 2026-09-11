import { Authorization } from "effect-domains/authorization"

import {
  ExampleRoles,
  ExampleSubjectSchema,
} from "@effect-domains/example-support/subject"


const policy = Authorization.subject(ExampleSubjectSchema)

const reportSubscription = policy.entitlement({
  name: "reports.generate",
  key: policy.subject.tenantId,
})

export const ReportExportGenerationAuthorization = policy.policy(
  ExampleRoles.editor.expression,
  { require: [reportSubscription] },
)

export const ReportExportOperatorAuthorization = policy.policy(
  ExampleRoles.admin.expression,
)
