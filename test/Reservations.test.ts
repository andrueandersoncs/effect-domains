import { expect, it } from "@effect/vitest"
import { Array, DateTime, Effect, Function, Option, Result, Schema, pipe } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { ReservationApplication } from "../examples/reservations/application.ts"

import {
  InsufficientStock,
  InventoryUnavailable,
  ReservationIdSchema,
  ReservationInputSchema,
  ReservationSchema,
  ReservationStateTransitions,
  ReserveStockInputSchema,
  SkuSchema,
  StockSchema,
} from "../examples/reservations/domain.ts"

import { InventoryMigrations } from "../examples/reservations/migrations.ts"
import { ReservationResource, StockResource } from "../examples/reservations/resources.ts"
import { seedStock } from "../examples/reservations/sqlite.ts"
import { Application } from "effect-domains/application"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { makeMigrationStore } from "effect-domains/sqlite-migrations"

const sku = SkuSchema.make("book")
const request = ReserveStockInputSchema.make({ sku, quantity: 1 })
const initialStock = StockSchema.make({ sku, available: 1 })

const inventoryClient = SqliteBunRuntime.sqlClient(":memory:", {
  migrations: InventoryMigrations,
})

const ReservationCodecSchema = Schema.toCodecJson(ReservationSchema)
const encodeReservation = Schema.encodeEffect(ReservationCodecSchema)

const withInventory = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  pipe(
    Effect.fn("Reservations.withInventory")(function* () {
      yield* Application.prepare(ReservationApplication)
      yield* seedStock(initialStock)

      return yield* effect
    })(),
    Effect.provide(ReservationApplication.handlers),
    Effect.provide(inventoryClient),
    Effect.scoped,
  )

const onlyOneConcurrentReservationAction = Effect.fn(
  "Reservations.onlyOneConcurrentReservation",
)(function* () {
  const client = yield* RpcTest.makeClient(ReservationApplication.group)
  const firstReservation = client.reserve(request)
  const secondReservation = client.reserve(request)
  const firstOutcome = Effect.result(firstReservation)
  const secondOutcome = Effect.result(secondReservation)

  const outcomes = yield* Effect.all(
    [firstOutcome, secondOutcome],
    { concurrency: "unbounded" },
  )

  const successes = Array.filter(outcomes, Result.isSuccess)
  const failures = Array.filter(outcomes, Result.isFailure)
  expect(successes).toHaveLength(1)
  expect(failures).toHaveLength(1)
  const reservedOption = Array.get(successes, 0)
  const rejectedOption = Array.get(failures, 0)
  const reserved = Option.getOrThrow(reservedOption)
  const rejected = Option.getOrThrow(rejectedOption)

  const insufficientStock = InsufficientStock.make({
    sku,
    requested: 1,
    available: 0,
  })

  const stock = yield* StockResource.repository.get(sku)

  const storedReservation = yield* ReservationResource.repository.get(
    reserved.success.id,
  )

  expect(rejected.failure).toEqual(insufficientStock)
  expect(stock).toEqual({ sku, available: 0 })
  expect(storedReservation).toEqual(reserved.success)
})()

const onlyOneConcurrentReservation = withInventory(
  onlyOneConcurrentReservationAction,
)

const onlyOneConcurrentReservationTest = Function.constant(
  onlyOneConcurrentReservation,
)

it.effect(
  "only one concurrent reservation can take the last item",
  onlyOneConcurrentReservationTest,
)

const terminalTransitionsAction = Effect.fn(
  "Reservations.terminalTransitions",
)(function* () {
  const client = yield* RpcTest.makeClient(ReservationApplication.group)
  const held = yield* client.reserve(request)
  const heldInput = ReservationInputSchema.make({ id: held.id })
  const released = yield* client.release(heldInput)
  const stockAfterRelease = yield* StockResource.repository.get(sku)

  expect(released.status).toBe("released")
  expect(stockAfterRelease).toEqual({ sku, available: 1 })

  const repeatedReleaseInput = ReservationInputSchema.make({ id: held.id })
  const repeatedReleaseEffect = client.release(repeatedReleaseInput)
  const repeatedRelease = yield* Effect.result(repeatedReleaseEffect)

  const repeatedReleaseFailure = ReservationStateTransitions.invalid("release", held.id, "released")

  const repeatedReleaseExpected = Result.fail(repeatedReleaseFailure)
  const stockAfterRepeatedRelease = yield* StockResource.repository.get(sku)

  expect(repeatedRelease).toEqual(repeatedReleaseExpected)
  expect(stockAfterRepeatedRelease).toEqual({ sku, available: 1 })

  const next = yield* client.reserve(request)
  const nextInput = ReservationInputSchema.make({ id: next.id })
  const confirmed = yield* client.confirm(nextInput)

  expect(confirmed.status).toBe("confirmed")

  const invalidReleaseInput = ReservationInputSchema.make({ id: next.id })
  const invalidReleaseEffect = client.release(invalidReleaseInput)
  const invalidRelease = yield* Effect.result(invalidReleaseEffect)

  const invalidReleaseFailure = ReservationStateTransitions.invalid("release", next.id, "confirmed")

  const invalidReleaseExpected = Result.fail(invalidReleaseFailure)
  const stockAfterInvalidRelease = yield* StockResource.repository.get(sku)
  const storedReservation = yield* ReservationResource.repository.get(next.id)

  expect(invalidRelease).toEqual(invalidReleaseExpected)
  expect(stockAfterInvalidRelease).toEqual({ sku, available: 0 })
  expect(storedReservation).toEqual(confirmed)
})()

const terminalTransitions = withInventory(terminalTransitionsAction)

const terminalTransitionsTest = Function.constant(terminalTransitions)

it.effect(
  "terminal transitions cannot release stock twice or release a confirmed purchase",
  terminalTransitionsTest,
)

const failedInsertRollsBackStockAction = Effect.fn(
  "Reservations.failedInsertRollsBackStock",
)(function* () {
  const database = yield* SqlClient.SqlClient
  const client = yield* RpcTest.makeClient(ReservationApplication.group)

  yield* database`CREATE TRIGGER reject_reservation BEFORE INSERT ON reservations
    BEGIN SELECT RAISE(ABORT, 'reservation storage unavailable'); END`

  const reservationEffect = client.reserve(request)
  const outcome = yield* Effect.result(reservationEffect)
  const inventoryUnavailable = InventoryUnavailable.make({})
  const expectedOutcome = Result.fail(inventoryUnavailable)
  const stockAfterFailure = yield* StockResource.repository.get(sku)
  yield* database`DROP TRIGGER reject_reservation`
  const recovered = yield* client.reserve(request)
  const stockAfterRecovery = yield* StockResource.repository.get(sku)

  expect(outcome).toEqual(expectedOutcome)
  expect(stockAfterFailure).toEqual({ sku, available: 1 })
  expect(recovered.status).toBe("held")
  expect(stockAfterRecovery).toEqual({ sku, available: 0 })
})()

const failedInsertRollsBackStock = withInventory(failedInsertRollsBackStockAction)

const failedInsertRollsBackStockTest = Function.constant(
  failedInsertRollsBackStock,
)

it.effect(
  "a failed reservation insert rolls back its stock decrement",
  failedInsertRollsBackStockTest,
)

const historicalSecondsMigrationAction = Effect.fn(
  "Reservations.migratesHistoricalSeconds",
)(function* () {
  const database = yield* SqlClient.SqlClient
  const initialOption = Array.get(InventoryMigrations, 0)
  const initial = Option.getOrThrow(initialOption)
  const initialStore = makeMigrationStore(database, [initial])
  yield* initialStore.prepare(initial.to.tables)

  const id = ReservationIdSchema.make("01941f29-7c00-7000-8000-000000000001")
  const seconds = 1735689600
  yield* database`INSERT INTO stock (sku, available) VALUES (${sku}, 0)`

  yield* database`INSERT INTO reservations (id, sku, quantity, status, created_at_seconds)
    VALUES (${id}, ${sku}, 1, 'held', ${seconds})`

  yield* Application.prepare(ReservationApplication)
  yield* Application.prepare(ReservationApplication)
  const historicalStock = StockSchema.make({ sku, available: 99 })
  yield* seedStock(historicalStock)

  const reservation = yield* ReservationResource.repository.get(id)
  const createdAtMillis = DateTime.toEpochMillis(reservation.createdAt)
  const stock = yield* StockResource.repository.get(sku)
  const wire = yield* encodeReservation(reservation)

  expect(createdAtMillis).toBe(seconds * 1000)
  expect(reservation.status).toBe("held")
  expect(stock).toEqual({ sku, available: 0 })
  expect(wire).toMatchObject({ createdAt: "2025-01-01T00:00:00.000Z" })

  const client = yield* RpcTest.makeClient(ReservationApplication.group)
  const historicalReservationInput = ReservationInputSchema.make({ id })

  yield* client.release(historicalReservationInput)

  const stockAfterRelease = yield* StockResource.repository.get(sku)

  expect(stockAfterRelease).toEqual({ sku, available: 1 })
})()

const historicalSecondsMigration = pipe(
  historicalSecondsMigrationAction,
  Effect.provide(ReservationApplication.handlers),
  Effect.provide(inventoryClient),
  Effect.scoped,
)

const historicalSecondsMigrationTest = Function.constant(
  historicalSecondsMigration,
)

it.effect(
  "historical seconds migrate once without losing reservations or resetting stock",
  historicalSecondsMigrationTest,
)
