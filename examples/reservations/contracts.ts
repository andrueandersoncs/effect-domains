import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import {
  InsufficientStock,
  InvalidReservationState,
  ReservationInputSchema,
  ReservationNotFound,
  ReservationSchema,
  ReserveStockInputSchema,
  UnknownSku,
} from "./domain.ts"
import { InventoryUnavailable } from "./inventory.ts"

const reserveErrorsSchema = Schema.Union([
  UnknownSku,
  InsufficientStock,
  InventoryUnavailable,
])

const reserveCommand = Rpc.make("reserve", {
  payload: ReserveStockInputSchema,
  success: ReservationSchema,
  error: reserveErrorsSchema,
})

const transitionErrorsSchema = Schema.Union([
  ReservationNotFound,
  InvalidReservationState,
  InventoryUnavailable,
])

const confirmCommand = Rpc.make("confirm", {
  payload: ReservationInputSchema,
  success: ReservationSchema,
  error: transitionErrorsSchema,
})

const releaseCommand = Rpc.make("release", {
  payload: ReservationInputSchema,
  success: ReservationSchema,
  error: transitionErrorsSchema,
})

export const ReservationCommands = RpcGroup.make(
  reserveCommand,
  confirmCommand,
  releaseCommand,
)
