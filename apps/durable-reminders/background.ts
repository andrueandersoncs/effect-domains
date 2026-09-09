import { ClusterCron, Singleton } from "effect/unstable/cluster"
import { SqlClient } from "effect/unstable/sql"
import { Array, Config, Cron, DateTime, Effect, Equivalence, FileSystem, Layer, Path, Schedule, Schema, pipe } from "effect"

import {
  ReminderDeliveryFailed,
  ReminderRecipientMismatch,
  reminderReceiptId,
} from "./domain.ts"

import {
  ReminderDelivery,
  ReminderRecipientEntity,
} from "./reminder-entity.ts"

import { ReminderReceiptResource } from "./resources.ts"

const persistenceFailure = (delivery: ReminderDelivery) =>
  ReminderDeliveryFailed.make({
    recipient: delivery.recipient,
    requestId: delivery.requestId,
  })

const persistReceipt = Effect.fn("DurableReminders.persistReceipt")(function* (database: SqlClient.SqlClient, delivery: ReminderDelivery) {
  const id = reminderReceiptId(delivery.recipient, delivery.requestId)

  const transaction = Effect.gen(function* () {
    const deliveredAt = yield* DateTime.now
    const scheduledFor = DateTime.formatIso(delivery.deliverAt)
    const delivered = DateTime.formatIso(deliveredAt)

    yield* database`
      INSERT OR IGNORE INTO ${database(ReminderReceiptResource.table.name)}
      ${database.insert({
        id,
        recipient: delivery.recipient,
        requestId: delivery.requestId,
        message: delivery.message,
        scheduledFor,
        deliveredAt: delivered,
        archivedAt: null,
      })}
    `

    const rows = yield* database<Readonly<Record<string, unknown>>>`
      SELECT * FROM ${database(ReminderReceiptResource.table.name)}
      WHERE ${database("id")} = ${id}
      LIMIT 1
    `

    const row = yield* pipe(rows, Array.head, Effect.fromOption, Effect.orDie)
    return yield* Schema.decodeUnknownEffect(ReminderReceiptResource.table.storageSchema)(row)
  })

  return yield* pipe(
    transaction,
    database.withTransaction,
    Effect.tapError((cause) => Effect.logError("Reminder receipt persistence failed", cause)),
    Effect.mapError(() => persistenceFailure(delivery)),
  )
})


const registerRecipient = Effect.gen(function* () {
  // Capture application SQL because native Sharding carries its private execution SQL context.
  const database = yield* SqlClient.SqlClient

  const handlers = ReminderRecipientEntity.of({
    Schedule: Effect.fn("DurableReminders.Schedule")(function* ({ payload, address }) {
      const matchesRecipient = Equivalence.strictEqual<string>()(address.entityId, payload.recipient)

      if (!matchesRecipient) {
        return yield* ReminderRecipientMismatch.make({ entityId: address.entityId, recipient: payload.recipient })
      }

      return yield* persistReceipt(database, payload)
    }),
  })

  return ReminderRecipientEntity.toLayer(handlers)
})

const writeReceiptProjection = pipe(Effect.gen(function* () {
  const database = yield* SqlClient.SqlClient
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const destination = yield* pipe(
    Config.string("DURABLE_REMINDERS_PROJECTION_FILE"),
    Config.withDefault("durable-reminders.receipts.json"),
  )

  const directory = path.dirname(destination)
  const prefix = `.${path.basename(destination)}.`

  const receipts = yield* database<Readonly<Record<string, unknown>>>`
    SELECT id, recipient, requestId, message, scheduledFor, deliveredAt, archivedAt
    FROM ${database(ReminderReceiptResource.table.name)}
    ORDER BY ${database("id")} ASC
  `

  yield* fileSystem.makeDirectory(directory, { recursive: true })
  const temporary = yield* fileSystem.makeTempFileScoped({ directory, prefix })
  const snapshot = `${JSON.stringify({ receipts }, null, 2)}\n`
  yield* fileSystem.writeFileString(temporary, snapshot)
  yield* fileSystem.rename(temporary, destination)
}), Effect.scoped)

const projectionSchedule = Schedule.spaced("5 seconds")

const receiptProjectionLoop = pipe(
  writeReceiptProjection,
  Effect.catch((cause) => Effect.logError("Reminder receipt projection failed", cause)),
  Effect.repeat(projectionSchedule),
)

const archiveDeliveredReceipts = Effect.fn("DurableReminders.archiveDeliveredReceipts")(function* (database: SqlClient.SqlClient) {
  const now = yield* DateTime.now
  const archivedAt = DateTime.formatIso(now)
  const retentionBoundary = pipe(now, DateTime.subtractDuration("90 days"), DateTime.formatIso)

  yield* database`
    UPDATE ${database(ReminderReceiptResource.table.name)}
    SET ${database("archivedAt")} = ${archivedAt}
    WHERE ${database("archivedAt")} IS NULL
      AND ${database("deliveredAt")} < ${retentionBoundary}
  `
})

const registerRetention = Effect.gen(function* () {
  const database = yield* SqlClient.SqlClient

  const expression = yield* pipe(
    Config.string("DURABLE_REMINDERS_RETENTION_CRON"),
    Config.withDefault("0 0 * * *"),
  )

  const cron = yield* pipe(Cron.parse(expression, "UTC"), Effect.fromResult)

  const execute = pipe(
    archiveDeliveredReceipts(database),
    Effect.catch((cause) => Effect.logError("Reminder receipt retention failed", cause)),
  )

  return ClusterCron.make({ name: "durable-reminders.receipt-retention", cron, execute })
})

const receiptRetention = Layer.unwrap(registerRetention)

const recipientRegistration = Layer.unwrap(registerRecipient)
const projection = Singleton.make("durable-reminders.receipt-projection", receiptProjectionLoop)
export const ReminderBackground = Layer.mergeAll(recipientRegistration, projection, receiptRetention)
