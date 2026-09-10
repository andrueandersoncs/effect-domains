import { ClusterSchema, DeliverAt, Entity, EntityProxy, EntityProxyServer } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { PrimaryKey, Schema } from "effect"
import { AppointmentReminderOperatorAuthorization } from "./operator-authorization.ts"

import {
  AppointmentIdSchema,
  AppointmentInboxNotificationSchema,
  AppointmentRecipientMismatch,
  AppointmentRecipientSchema,
  AppointmentReminderDeliveryFailed,
  AppointmentReminderIdSchema,
  ReminderMustPrecedeAppointment,
} from "./domain.ts"

export class AppointmentReminderDelivery extends Schema.Class<AppointmentReminderDelivery>(
  "examples/appointment-reminders/AppointmentReminderDelivery",
)({
  recipient: AppointmentRecipientSchema,
  reminderId: AppointmentReminderIdSchema,
  appointmentId: AppointmentIdSchema,
  appointmentAt: Schema.DateTimeUtc,
  reminderAt: Schema.DateTimeUtc,
  location: Schema.NonEmptyString,
  purpose: Schema.NonEmptyString,
}) implements PrimaryKey.PrimaryKey, DeliverAt.DeliverAt {
  static [PrimaryKey.symbol](this: AppointmentReminderDelivery): string {
    return this.reminderId
  }

  static [DeliverAt.symbol](this: AppointmentReminderDelivery) {
    return this.reminderAt
  }

  readonly [PrimaryKey.symbol] = AppointmentReminderDelivery[PrimaryKey.symbol]
  readonly [DeliverAt.symbol] = AppointmentReminderDelivery[DeliverAt.symbol]
}

const deliveryErrorSchema = Schema.Union([
  AppointmentReminderDeliveryFailed,
  AppointmentRecipientMismatch,
  ReminderMustPrecedeAppointment,
])

const scheduleAppointmentReminder = Rpc.make("ScheduleReminder", {
  payload: AppointmentReminderDelivery,
  success: AppointmentInboxNotificationSchema,
  error: deliveryErrorSchema,
})

export const AppointmentRecipientEntity = Entity.make("AppointmentRecipient", [
  scheduleAppointmentReminder,
]).annotateRpcs(ClusterSchema.Persisted, true)

export const AppointmentRecipientProxy = EntityProxy.toRpcGroup(
  AppointmentRecipientEntity,
)
  .middleware(AppointmentReminderOperatorAuthorization)

export const AppointmentReminderEntityCommands = {
  group: AppointmentRecipientProxy,
  handlers: EntityProxyServer.layerRpcHandlers(AppointmentRecipientEntity),
}
