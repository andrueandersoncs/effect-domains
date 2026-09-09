import { Schema, pipe } from "effect"
import { identifier } from "effect-domains/domain"

export const RecipientSchema = pipe(
  Schema.NonEmptyString,
  Schema.brand("ReminderRecipient"),
)

const isUuidV7 = Schema.isUUID(7)

export const ReminderRequestIdSchema = pipe(
  Schema.String.check(isUuidV7),
  Schema.brand("ReminderRequestId"),
)


export const ReminderReceiptIdSchema = pipe(
  Schema.NonEmptyString,
  Schema.brand("ReminderReceiptId"),
  identifier,
)

export const reminderReceiptId = (
  recipient: typeof RecipientSchema.Type,
  requestId: typeof ReminderRequestIdSchema.Type,
) => pipe(JSON.stringify([recipient, requestId]), ReminderReceiptIdSchema.make)

export const ReminderReceiptSchema = Schema.Struct({
  id: ReminderReceiptIdSchema,
  recipient: RecipientSchema,
  requestId: ReminderRequestIdSchema,
  message: Schema.NonEmptyString,
  scheduledFor: Schema.DateTimeUtc,
  deliveredAt: Schema.DateTimeUtc,
  archivedAt: Schema.NullOr(Schema.DateTimeUtc),
})

interface ReminderReceipt extends Schema.Schema.Type<typeof ReminderReceiptSchema> {}

export class ReminderDeliveryFailed extends Schema.TaggedError<ReminderDeliveryFailed>()(
  "ReminderDeliveryFailed",
  {
    recipient: RecipientSchema,
    requestId: ReminderRequestIdSchema,
  },
) {}

export class ReminderRecipientMismatch extends Schema.TaggedError<ReminderRecipientMismatch>()(
  "ReminderRecipientMismatch",
  {
    entityId: Schema.String,
    recipient: RecipientSchema,
  },
) {}
