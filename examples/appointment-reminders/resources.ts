import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ExampleSubjectSchema } from "@effect-domains/example-support/authentication"
import { AppointmentInboxNotificationSchema } from "./domain.ts"

const policy = Authorization.for({
  resource: AppointmentInboxNotificationSchema,
  subject: ExampleSubjectSchema,
})

const operator = policy.includes(policy.subject.roles, "admin")

const authorization = policy.policy({
  scope: operator,
  allow: { read: operator },
})

export const AppointmentInboxNotificationResource = Resource.make({
  authorization,
  name: "appointment_notifications",
  schema: AppointmentInboxNotificationSchema,
  operations: {
    get: true,
    list: {
      filter: ["recipient", "appointmentId", "reminderId"],
      limit: 100,
    },
  },
})
