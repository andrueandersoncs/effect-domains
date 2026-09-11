import { Array, Effect, Equivalence, Option, Schema } from "effect"

import { SqlClient } from "effect/unstable/sql"

import { Operation } from "effect-domains/operation"
import { ResourceNotFound } from "effect-domains/repository-store"

import {
  InsufficientStock,
  InventoryUnavailable,
  type Reservation,
  type ReservationInput,
  ReservationInputSchema,
  ReservationSchema,
  ReservationStateTransitions,
  type ReserveStockInput,
  ReserveStockInputSchema,
  type Stock,
  UnknownSku,
} from "./domain.ts"

import { ReservationResource, StockResource } from "./resources.ts"

export const seedStock = Effect.fn("Inventory.seedStock")(function* (
  stock: Stock,
) {
  yield* StockResource.repository.ensure(stock)
})

const reserve = Effect.fn("Inventory.reserve")(function* (
  input: ReserveStockInput,
) {
  const database = yield* SqlClient.SqlClient
  const stock = yield* StockResource.repository.find(input.sku)

  if (Option.isNone(stock)) {
    return yield* UnknownSku.make({ sku: input.sku })
  }

  const decremented = yield* database`
    UPDATE ${database(StockResource.table.name)}
    SET ${database("available")} = ${database("available")} - ${input.quantity}
    WHERE ${database("sku")} = ${input.sku}
      AND ${database("available")} >= ${input.quantity}
    RETURNING 1
  `

  if (Array.isReadonlyArrayEmpty(decremented)) {
    return yield* InsufficientStock.make({
      sku: input.sku,
      requested: input.quantity,
      available: stock.value.available,
    })
  }

  return yield* ReservationResource.repository.create({
    sku: input.sku,
    quantity: input.quantity,
  })
})

const restoreStock = Effect.fn("Inventory.restoreStock")(function* (
  database: SqlClient.SqlClient,
  reservation: Reservation,
) {
  const replenished = yield* database`
    UPDATE ${database(StockResource.table.name)}
    SET ${database("available")} = ${database("available")} + ${reservation.quantity}
    WHERE ${database("sku")} = ${reservation.sku}
      AND ${database("available")} <= ${Number.MAX_SAFE_INTEGER - reservation.quantity}
    RETURNING 1
  `

  if (Array.isReadonlyArrayEmpty(replenished)) {
    return yield* InventoryUnavailable.make({})
  }
})

const transition = (action: "confirm" | "release") =>
  Effect.fn("Inventory.transition")(function* (input: ReservationInput) {
    const reservation = yield* ReservationResource.repository.transition(
      input.id,
      action,
    )

    if (Equivalence.strictEqual()(action, "release")) {
      const database = yield* SqlClient.SqlClient
      yield* restoreStock(database, reservation)
    }

    return reservation
  })

const operationErrorsSchema = Schema.Union([
  UnknownSku,
  InsufficientStock,
  ResourceNotFound,
  ReservationStateTransitions.Error,
  InventoryUnavailable,
])

const reserveStock = Operation.make({
  name: "reserve",
  payload: ReserveStockInputSchema,
  success: ReservationSchema,
  error: operationErrorsSchema,
  transaction: true,
  unavailable: InventoryUnavailable,
  handler: reserve,
})

const confirmReservation = Operation.make({
  name: "confirm",
  payload: ReservationInputSchema,
  success: ReservationSchema,
  error: operationErrorsSchema,
  transaction: true,
  unavailable: InventoryUnavailable,
  handler: transition("confirm"),
})

const releaseReservation = Operation.make({
  name: "release",
  payload: ReservationInputSchema,
  success: ReservationSchema,
  error: operationErrorsSchema,
  transaction: true,
  unavailable: InventoryUnavailable,
  handler: transition("release"),
})

export const InventoryOperations = Operation.bundle(
  reserveStock,
  confirmReservation,
  releaseReservation,
)
