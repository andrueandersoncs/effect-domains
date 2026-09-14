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

const notificationCapabilities = [
  Resource.get(),
  Resource.list({
    filter: ["recipient", "appointmentId", "reminderId"],
    limit: 100,
  }),
]

export const AppointmentInboxNotificationResource = Resource.define({
  authorization,
  name: "appointment_notifications",
  schema: AppointmentInboxNotificationSchema,
  capabilities: notificationCapabilities,
})
