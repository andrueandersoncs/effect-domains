import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ExampleSubjectSchema } from "@effect-domains/example-support/subject"
import { AppointmentInboxNotificationSchema } from "./domain.ts"
import { AppointmentReminderOperatorAuthorization } from "./operator-authorization.ts"

const policy = Authorization.for({
  resource: AppointmentInboxNotificationSchema,
  subject: ExampleSubjectSchema,
})


const authorization = policy.policy({
  scope: AppointmentReminderOperatorAuthorization.expression,
  allow: { read: AppointmentReminderOperatorAuthorization.expression },
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
