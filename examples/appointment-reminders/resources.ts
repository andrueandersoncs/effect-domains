import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ExampleRoles, ExampleSubjectSchema } from "@effect-domains/example-support/subject"
import { AppointmentInboxNotificationSchema } from "./domain.ts"

const policy = Authorization.for({
  resource: AppointmentInboxNotificationSchema,
  subject: ExampleSubjectSchema,
})

const authorization = policy.policy({
  scope: ExampleRoles.admin,
  allow: { read: ExampleRoles.admin, create: ExampleRoles.admin },
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
