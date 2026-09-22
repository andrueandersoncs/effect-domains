import { Application, Part } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { AppointmentReminderEntityCommands } from "./appointment-reminder-entity.ts"
import { AppointmentInboxNotificationResource } from "./resources.ts"
import { Effect } from "effect"

const parts = [
  Part.resource(AppointmentInboxNotificationResource),
  Part.native(AppointmentReminderEntityCommands),
  Part.native(IdentityBundle),
]

const appointmentReminders = Application.define({
  name: "appointment-reminders",
  parts,
})

const appointmentRemindersCompiler = Application.compile(appointmentReminders)
const appointmentRemindersApplication = Effect.runSync(appointmentRemindersCompiler)

export { appointmentRemindersApplication as AppointmentRemindersApplication }
