import { Commands } from "effect-domains/commands"
import { Schema } from "effect"
import { RpcGroup } from "effect/unstable/rpc"
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
  payload: ReservationInputSchema,
  success: ReservationSchema,
  error: transitionErrorsSchema,
}

const reserve = Commands.rpc("reserve", {
  payload: ReserveStockInputSchema,
  success: transition.success,
  error: reserveErrorsSchema,
})

const confirm = Commands.rpc("confirm", transition)
const release = Commands.rpc("release", transition)
const reservationRpcs = RpcGroup.make(reserve, confirm, release)

export const Inventory = Commands.make({
  name: "examples/reservations/Inventory",
  group: reservationRpcs,
})
