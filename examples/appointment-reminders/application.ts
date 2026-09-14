import { Application, Part } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { AppointmentReminderEntityCommands } from "./appointment-reminder-entity.ts"
import { AppointmentInboxNotificationResource } from "./resources.ts"

export const AppointmentRemindersApplication = Application.compile(Application.define({
  name: "appointment-reminders",
  parts: [
    Part.resource(AppointmentInboxNotificationResource),
    Part.native(AppointmentReminderEntityCommands),
    Part.native(IdentityBundle),
  ],
}))
