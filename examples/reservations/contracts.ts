import { Commands, type CommandContract, type CommandContracts } from "effect-domains/commands"
import { Schema } from "effect"
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

const transitionContract = {
  input: ReservationInputSchema,
  output: ReservationSchema,
  error: transitionErrorsSchema,
} satisfies CommandContract

const reservationContracts = {
  reserve: {
    input: ReserveStockInputSchema,
    output: ReservationSchema,
    error: reserveErrorsSchema,
  },
  confirm: transitionContract,
  release: transitionContract,
} satisfies CommandContracts

export const Inventory = Commands.make(
  "examples/reservations/Inventory",
  reservationContracts,
)
