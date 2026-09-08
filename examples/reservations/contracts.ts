import { Schema } from "effect"
import type { CommandContract, CommandContracts } from "effect-domains/application"
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

const transitionErrorsSchema = Schema.Union([
  ReservationNotFound,
  InvalidReservationState,
  InventoryUnavailable,
])

const transitionContract = {
  input: ReservationInputSchema,
  output: ReservationSchema,
  error: transitionErrorsSchema,
} satisfies CommandContract

export const ReservationCommands = {
  reserve: {
    input: ReserveStockInputSchema,
    output: ReservationSchema,
    error: reserveErrorsSchema,
  },
  confirm: transitionContract,
  release: transitionContract,
} satisfies CommandContracts
