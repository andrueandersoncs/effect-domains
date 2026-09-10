import { Authorization } from "effect-domains/authorization"
import { ExampleSubjectSchema } from "@effect-domains/example-support/authentication"

const policy = Authorization.subject(ExampleSubjectSchema)
const operator = policy.includes(policy.subject.roles, "admin")
export const AppointmentReminderOperatorAuthorization = policy.policy(operator)
