import { Array, Effect, Equivalence, Option, Schema } from "effect"

import { SqlClient } from "effect/unstable/sql"

import { Command } from "effect-domains/command"
import { ResourceNotFound } from "effect-domains/repository-store"
import { Resource } from "effect-domains/resource"

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
  yield* Resource.repository(StockResource).ensure(stock)
})

const reserve = Effect.fn("Inventory.reserve")(function* (
  input: ReserveStockInput,
) {
  const database = yield* SqlClient.SqlClient
  const stock = yield* Resource.repository(StockResource).find(input.sku)

  if (Option.isNone(stock)) {
    return yield* UnknownSku.make({ sku: input.sku })
  }

  const decremented = yield* database`
    UPDATE ${database(Resource.table(StockResource).name)}
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

  return yield* Resource.repository(ReservationResource).create({
    sku: input.sku,
    quantity: input.quantity,
  })
})

const restoreStock = Effect.fn("Inventory.restoreStock")(function* (
  database: SqlClient.SqlClient,
  reservation: Reservation,
) {
  const replenished = yield* database`
    UPDATE ${database(Resource.table(StockResource).name)}
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
    const reservation = yield* Resource.repository(ReservationResource).transition(
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
])

const InventoryCommand = Command
  .family("", InventoryUnavailable)
  .transactional()

const reserveStockSpec = InventoryCommand.define({
  name: "reserve",
  payload: ReserveStockInputSchema,
  success: ReservationSchema,
  errors: operationErrorsSchema,
  dependencies: [StockResource, ReservationResource],
})

const reserveStock = Command.implement(reserveStockSpec, reserve)

const confirmReservationSpec = InventoryCommand.define({
  name: "confirm",
  payload: ReservationInputSchema,
  success: ReservationSchema,
  errors: operationErrorsSchema,
  dependencies: [ReservationResource],
})

const confirmReservation = Command.implement(
  confirmReservationSpec,
  transition("confirm"),
)

const releaseReservationSpec = InventoryCommand.define({
  name: "release",
  payload: ReservationInputSchema,
  success: ReservationSchema,
  errors: operationErrorsSchema,
  dependencies: [ReservationResource, StockResource],
})

const releaseReservation = Command.implement(
  releaseReservationSpec,
  transition("release"),
)

export const InventoryOperations = Command.bundle(
  reserveStock,
  confirmReservation,
  releaseReservation,
)
