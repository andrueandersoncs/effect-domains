import { Commands } from "effect-domains/commands"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import {
  InsufficientStock,
  InvalidReservationState,
  InventoryUnavailable,
  ReservationInputSchema,
  ReservationNotFound,
  ReservationSchema,
  ReserveStockInputSchema,
  UnknownSku,
} from "./domain.ts"

const reserveErrorsSchema = Schema.Union([
  UnknownSku,
  InsufficientStock,
  InventoryUnavailable,
])

const transitionErrorsSchema = Schema.Union([
  ReservationNotFound,
  InvalidReservationState,
  InventoryUnavailable,
])

const transition = {
  payload: Schema.toCodecJson(ReservationInputSchema),
  success: Schema.toCodecJson(ReservationSchema),
  error: Schema.toCodecJson(transitionErrorsSchema),
}

const reservePayloadSchema = Schema.toCodecJson(ReserveStockInputSchema)
const reserveErrorSchema = Schema.toCodecJson(reserveErrorsSchema)

const reserve = Rpc.make("reserve", {
  payload: reservePayloadSchema,
  success: transition.success,
  error: reserveErrorSchema,
})

const confirm = Rpc.make("confirm", transition)
const release = Rpc.make("release", transition)
const reservationRpcs = RpcGroup.make(reserve, confirm, release)

export const Inventory = Commands.make({
  name: "examples/reservations/Inventory",
  group: reservationRpcs,
})
