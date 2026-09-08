import { expect, it } from "@effect/vitest"
import { Array, Context, DateTime, Effect, Function, Option, Result, Schema, pipe } from "effect"
import { ReservationApplication } from "../examples/reservations/application.ts"
import { Inventory } from "../examples/reservations/contracts.ts"
import {
  InsufficientStock,
  InvalidReservationState,
  InventoryUnavailable,
  ReservationIdSchema,
  ReservationInputSchema,
  ReservationSchema,
  ReserveStockInputSchema,
  SkuSchema,
  StockSchema,
} from "../examples/reservations/domain.ts"
import { InventoryMigrations } from "../examples/reservations/migrations.ts"
import { ReservationResource, StockResource } from "../examples/reservations/resources.ts"
import { InventorySqlite, seedStock } from "../examples/reservations/sqlite.ts"
import { Application } from "../src/application.ts"
import { RepositoryStore } from "../src/repository-store.ts"
import { SqliteBunRuntime } from "../src/sqlite-bun.ts"
import { SqlClient } from "effect/unstable/sql"
import { makeMigrationStore } from "../src/sqlite-migrations.ts"

const sku = SkuSchema.make("book")
const request = ReserveStockInputSchema.make({ sku, quantity: 1 })
const initialStock = StockSchema.make({ sku, available: 1 })

const inventoryClient = SqliteBunRuntime.sqlClient(":memory:", {
  migrations: InventoryMigrations,
})

const ReservationCodecSchema = Schema.toCodecJson(ReservationSchema)
const encodeReservation = Schema.encodeEffect(ReservationCodecSchema)

const withInventory = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    Context.Service.Identifier<typeof Inventory> | SqlClient.SqlClient | RepositoryStore
  >,
) =>
  pipe(
    Effect.fn("Reservations.withInventory")(function* () {
      yield* Application.prepare(ReservationApplication)
      yield* seedStock(initialStock)

      return yield* pipe(effect, Effect.provide(InventorySqlite))
    })(),
    Effect.provide(inventoryClient),
  )

const onlyOneConcurrentReservationAction = Effect.fn(
  "Reservations.onlyOneConcurrentReservation",
)(function* () {
  const inventory = yield* Inventory
  const firstReservation = inventory.reserve(request)
  const secondReservation = inventory.reserve(request)
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
  const inventory = yield* Inventory
  const held = yield* inventory.reserve(request)
  const heldInput = ReservationInputSchema.make({ id: held.id })
  const released = yield* inventory.release(heldInput)
  const stockAfterRelease = yield* StockResource.repository.get(sku)

  expect(released.status).toBe("released")
  expect(stockAfterRelease).toEqual({ sku, available: 1 })

  const repeatedReleaseInput = ReservationInputSchema.make({ id: held.id })
  const repeatedReleaseEffect = inventory.release(repeatedReleaseInput)
  const repeatedRelease = yield* Effect.result(repeatedReleaseEffect)

  const repeatedReleaseFailure = InvalidReservationState.make({
    id: held.id,
    action: "release",
    actual: "released",
  })

  const repeatedReleaseExpected = Result.fail(repeatedReleaseFailure)
  const stockAfterRepeatedRelease = yield* StockResource.repository.get(sku)

  expect(repeatedRelease).toEqual(repeatedReleaseExpected)
  expect(stockAfterRepeatedRelease).toEqual({ sku, available: 1 })

  const next = yield* inventory.reserve(request)
  const nextInput = ReservationInputSchema.make({ id: next.id })
  const confirmed = yield* inventory.confirm(nextInput)

  expect(confirmed.status).toBe("confirmed")

  const invalidReleaseInput = ReservationInputSchema.make({ id: next.id })
  const invalidReleaseEffect = inventory.release(invalidReleaseInput)
  const invalidRelease = yield* Effect.result(invalidReleaseEffect)

  const invalidReleaseFailure = InvalidReservationState.make({
    id: next.id,
    action: "release",
    actual: "confirmed",
  })

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
  const inventory = yield* Inventory
  yield* database`CREATE TRIGGER reject_reservation BEFORE INSERT ON reservations
    BEGIN SELECT RAISE(ABORT, 'reservation storage unavailable'); END`
  const reservationEffect = inventory.reserve(request)
  const outcome = yield* Effect.result(reservationEffect)
  const inventoryUnavailable = InventoryUnavailable.make({})
  const expectedOutcome = Result.fail(inventoryUnavailable)
  const stockAfterFailure = yield* StockResource.repository.get(sku)
  yield* database`DROP TRIGGER reject_reservation`
  const recovered = yield* inventory.reserve(request)
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

  const releaseHistoricalReservationAction = Effect.fn(
    "Reservations.releaseHistoricalReservation",
  )(function* () {
    const inventory = yield* Inventory
    const historicalReservationInput = ReservationInputSchema.make({ id })

    yield* inventory.release(historicalReservationInput)
  })()

  yield* pipe(
    releaseHistoricalReservationAction,
    Effect.provide(InventorySqlite),
  )
  const stockAfterRelease = yield* StockResource.repository.get(sku)

  expect(stockAfterRelease).toEqual({ sku, available: 1 })
})()

const historicalSecondsMigration = pipe(
  historicalSecondsMigrationAction,
  Effect.provide(inventoryClient),
)

const historicalSecondsMigrationTest = Function.constant(
  historicalSecondsMigration,
)

it.effect(
  "historical seconds migrate once without losing reservations or resetting stock",
  historicalSecondsMigrationTest,
)
