import { Application, Part } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { AppointmentReminderEntityCommands } from "./appointment-reminder-entity.ts"
import { AppointmentInboxNotificationResource } from "./resources.ts"

const parts = [
  Part.resource(AppointmentInboxNotificationResource),
  Part.native(AppointmentReminderEntityCommands),
  Part.native(IdentityBundle),
]

const appointmentReminders = Application.define({
  name: "appointment-reminders",
  parts,
})

export const AppointmentRemindersApplication = Application.compile(appointmentReminders)
