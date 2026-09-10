import { ClusterCron, Singleton } from "effect/unstable/cluster"
import { SqlClient } from "effect/unstable/sql"
import { Array, Config, Cron, DateTime, Effect, Equivalence, Layer, Schedule, Schema, pipe } from "effect"
import { replaceFileAtomically } from "@effect-domains/example-support/files"

import {
  AppointmentReminderDeliveryFailed,
  AppointmentRecipientMismatch,
  appointmentInboxNotificationId,
  ReminderMustPrecedeAppointment,
} from "./domain.ts"

import {
  AppointmentReminderDelivery,
  AppointmentRecipientEntity,
} from "./appointment-reminder-entity.ts"

import { AppointmentInboxNotificationResource } from "./resources.ts"

const persistenceFailure = (delivery: AppointmentReminderDelivery) =>
  AppointmentReminderDeliveryFailed.make({
    recipient: delivery.recipient,
    reminderId: delivery.reminderId,
  })

const reminderPrecedesAppointment = (delivery: AppointmentReminderDelivery) =>
  DateTime.isLessThan(delivery.reminderAt, delivery.appointmentAt)

const persistInboxNotification = Effect.fn("AppointmentReminders.persistInboxNotification")(function* (
  database: SqlClient.SqlClient,
  delivery: AppointmentReminderDelivery,
) {
  const id = appointmentInboxNotificationId(delivery.recipient, delivery.reminderId)

  const transaction = Effect.gen(function* () {
    const deliveredAt = yield* DateTime.now
    const appointmentAt = DateTime.formatIso(delivery.appointmentAt)
    const reminderAt = DateTime.formatIso(delivery.reminderAt)
    const delivered = DateTime.formatIso(deliveredAt)

    yield* database`
      INSERT OR IGNORE INTO ${database(AppointmentInboxNotificationResource.table.name)}
      ${database.insert({
        id,
        recipient: delivery.recipient,
        reminderId: delivery.reminderId,
        appointmentId: delivery.appointmentId,
        appointmentAt,
        reminderAt,
        location: delivery.location,
        purpose: delivery.purpose,
        deliveredAt: delivered,
        archivedAt: null,
      })}
    `

    const rows = yield* database<Readonly<Record<string, unknown>>>`
      SELECT * FROM ${database(AppointmentInboxNotificationResource.table.name)}
      WHERE ${database("id")} = ${id}
      LIMIT 1
    `

    const row = yield* pipe(rows, Array.head, Effect.fromOption, Effect.orDie)
    return yield* Schema.decodeUnknownEffect(AppointmentInboxNotificationResource.table.storageSchema)(row)
  })

  return yield* pipe(
    transaction,
    database.withTransaction,
    Effect.tapError((cause) => Effect.logError("Appointment inbox notification persistence failed", cause)),
    Effect.mapError(() => persistenceFailure(delivery)),
  )
})

const registerAppointmentRecipient = Effect.gen(function* () {
  // Capture application SQL because native Sharding carries its private execution SQL context.
  const database = yield* SqlClient.SqlClient

  const handlers = AppointmentRecipientEntity.of({
    ScheduleReminder: Effect.fn("AppointmentReminders.ScheduleReminder")(function* ({ payload, address }) {
      const matchesRecipient = Equivalence.strictEqual<string>()(address.entityId, payload.recipient)

      if (!matchesRecipient) {
        return yield* AppointmentRecipientMismatch.make({ entityId: address.entityId, recipient: payload.recipient })
      }

      if (!reminderPrecedesAppointment(payload)) {
        return yield* ReminderMustPrecedeAppointment.make({
          appointmentId: payload.appointmentId,
          appointmentAt: payload.appointmentAt,
          reminderAt: payload.reminderAt,
        })
      }

      return yield* persistInboxNotification(database, payload)
    }),
  })

  return AppointmentRecipientEntity.toLayer(handlers)
})

const writeInboxProjection = Effect.gen(function* () {
  const database = yield* SqlClient.SqlClient

  const destination = yield* pipe(
    Config.string("APPOINTMENT_REMINDERS_PROJECTION_FILE"),
    Config.withDefault("appointment-reminders.notifications.json"),
  )

  const notifications = yield* database<Readonly<Record<string, unknown>>>`
    SELECT id, recipient, reminderId, appointmentId, appointmentAt, reminderAt, location, purpose, deliveredAt, archivedAt
    FROM ${database(AppointmentInboxNotificationResource.table.name)}
    ORDER BY ${database("id")} ASC
  `

  const snapshot = `${JSON.stringify({ notifications }, null, 2)}\n`
  yield* replaceFileAtomically({ path: destination, contents: snapshot })
})

const projectionSchedule = Schedule.spaced("5 seconds")

const inboxProjectionLoop = pipe(
  writeInboxProjection,
  Effect.catch((cause) => Effect.logError("Appointment inbox projection failed", cause)),
  Effect.repeat(projectionSchedule),
)

const archiveDeliveredNotifications = Effect.fn("AppointmentReminders.archiveDeliveredNotifications")(function* (database: SqlClient.SqlClient) {
  const now = yield* DateTime.now
  const archivedAt = DateTime.formatIso(now)
  const retentionBoundary = pipe(now, DateTime.subtractDuration("90 days"), DateTime.formatIso)

  yield* database`
    UPDATE ${database(AppointmentInboxNotificationResource.table.name)}
    SET ${database("archivedAt")} = ${archivedAt}
    WHERE ${database("archivedAt")} IS NULL
      AND ${database("deliveredAt")} < ${retentionBoundary}
  `
})

const registerRetention = Effect.gen(function* () {
  const database = yield* SqlClient.SqlClient

  const expression = yield* pipe(
    Config.string("APPOINTMENT_REMINDERS_RETENTION_CRON"),
    Config.withDefault("0 0 * * *"),
  )

  const cron = yield* pipe(Cron.parse(expression, "UTC"), Effect.fromResult)

  const execute = pipe(
    archiveDeliveredNotifications(database),
    Effect.catch((cause) => Effect.logError("Appointment notification retention failed", cause)),
  )

  return ClusterCron.make({ name: "appointment-reminders.notification-retention", cron, execute })
})

const notificationRetention = Layer.unwrap(registerRetention)
const recipientRegistration = Layer.unwrap(registerAppointmentRecipient)
const projection = Singleton.make("appointment-reminders.inbox-projection", inboxProjectionLoop)
export const AppointmentReminderBackground = Layer.mergeAll(recipientRegistration, projection, notificationRetention)
