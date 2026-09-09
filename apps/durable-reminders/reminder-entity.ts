import { ClusterSchema, DeliverAt, Entity, EntityProxy, EntityProxyServer } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { PrimaryKey, Schema } from "effect"
import { OperatorAuthorization } from "./operator-authorization.ts"

import {
  ReminderDeliveryFailed,
  ReminderReceiptSchema,
  ReminderRecipientMismatch,
  ReminderRequestIdSchema,
  RecipientSchema,
} from "./domain.ts"

export class ReminderDelivery extends Schema.Class<ReminderDelivery>(
  "apps/durable-reminders/ReminderDelivery",
)({
  recipient: RecipientSchema,
  requestId: ReminderRequestIdSchema,
  message: Schema.NonEmptyString,
  deliverAt: Schema.DateTimeUtc,
}) implements PrimaryKey.PrimaryKey, DeliverAt.DeliverAt {
  static [PrimaryKey.symbol](this: ReminderDelivery): string {
    return this.requestId
  }

  static [DeliverAt.symbol](this: ReminderDelivery) {
    return this.deliverAt
  }

  // Share protocol functions because each decoded payload must expose native scheduling hooks.
  readonly [PrimaryKey.symbol] = ReminderDelivery[PrimaryKey.symbol]
  readonly [DeliverAt.symbol] = ReminderDelivery[DeliverAt.symbol]
}

const deliveryErrorSchema = Schema.Union([ReminderDeliveryFailed, ReminderRecipientMismatch])

const scheduleReminder = Rpc.make("Schedule", {
  payload: ReminderDelivery,
  success: ReminderReceiptSchema,
  error: deliveryErrorSchema,
})

export const ReminderRecipientEntity = Entity.make("ReminderRecipient", [
  scheduleReminder,
]).annotateRpcs(ClusterSchema.Persisted, true)

// Authorize at the proxy because HTTP authentication does not survive persisted entity delivery.
export const ReminderRecipientProxy = EntityProxy.toRpcGroup(
  ReminderRecipientEntity,
)
  .middleware(OperatorAuthorization)

export const ReminderEntityCommands = {
  group: ReminderRecipientProxy,
  handlers: EntityProxyServer.layerRpcHandlers(ReminderRecipientEntity),
}
