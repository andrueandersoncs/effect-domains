import { Application } from "effect-domains/application"
import { AppointmentReminderEntityCommands } from "./appointment-reminder-entity.ts"
import { AppointmentInboxNotificationResource } from "./resources.ts"

export const AppointmentRemindersApplication = Application.make({
  name: "appointment-reminders",
  parts: [AppointmentInboxNotificationResource, AppointmentReminderEntityCommands],
})
