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

const ReservationCodecSchema = Schema.toCodecJson(ReservationSchema)

const transition = {
  payload: ReservationInputSchema,
  success: ReservationCodecSchema,
  error: transitionErrorsSchema,
}

const reserveStock = Rpc.make("reserve", {
  payload: ReserveStockInputSchema,
  success: ReservationCodecSchema,
  error: reserveErrorsSchema,
})

const confirmReservation = Rpc.make("confirm", transition)
const releaseReservation = Rpc.make("release", transition)

export const InventoryRpcs = RpcGroup.make(
  reserveStock,
  confirmReservation,
  releaseReservation,
)
