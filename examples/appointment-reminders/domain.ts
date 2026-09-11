import { Schema, pipe } from "effect"
import { UuidV7Schema, identifier } from "effect-domains/domain"

export const AppointmentRecipientSchema = pipe(
  Schema.NonEmptyString,
  Schema.brand("AppointmentRecipient"),
)

export const AppointmentReminderIdSchema = pipe(
  UuidV7Schema,
  Schema.brand("AppointmentReminderId"),
)

export const AppointmentIdSchema = pipe(
  UuidV7Schema,
  Schema.brand("AppointmentId"),
)

export const AppointmentInboxNotificationIdSchema = pipe(
  Schema.NonEmptyString,
  Schema.brand("AppointmentInboxNotificationId"),
  identifier,
)

export const appointmentInboxNotificationId = (
  recipient: typeof AppointmentRecipientSchema.Type,
  reminderId: typeof AppointmentReminderIdSchema.Type,
) => pipe(JSON.stringify([recipient, reminderId]), AppointmentInboxNotificationIdSchema.make)

export const AppointmentInboxNotificationSchema = Schema.Struct({
  id: AppointmentInboxNotificationIdSchema,
  recipient: AppointmentRecipientSchema,
  reminderId: AppointmentReminderIdSchema,
  appointmentId: AppointmentIdSchema,
  appointmentAt: Schema.DateTimeUtc,
  reminderAt: Schema.DateTimeUtc,
  location: Schema.NonEmptyString,
  purpose: Schema.NonEmptyString,
  deliveredAt: Schema.DateTimeUtc,
  archivedAt: Schema.NullOr(Schema.DateTimeUtc),
})

export class AppointmentReminderDeliveryFailed extends Schema.TaggedError<AppointmentReminderDeliveryFailed>()(
  "AppointmentReminderDeliveryFailed",
  {
    recipient: AppointmentRecipientSchema,
    reminderId: AppointmentReminderIdSchema,
  },
) {}

export class AppointmentRecipientMismatch extends Schema.TaggedError<AppointmentRecipientMismatch>()(
  "AppointmentRecipientMismatch",
  {
    entityId: Schema.String,
    recipient: AppointmentRecipientSchema,
  },
) {}

export class ReminderMustPrecedeAppointment extends Schema.TaggedError<ReminderMustPrecedeAppointment>()(
  "ReminderMustPrecedeAppointment",
  {
    appointmentId: AppointmentIdSchema,
    appointmentAt: Schema.DateTimeUtc,
    reminderAt: Schema.DateTimeUtc,
  },
) {}

interface AppointmentInboxNotification extends Schema.Schema.Type<typeof AppointmentInboxNotificationSchema> {}
