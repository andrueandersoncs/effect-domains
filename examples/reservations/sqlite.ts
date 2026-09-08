import {
  Array,
  DateTime,
  Effect,
  Equivalence,
  Layer,
  Option,
  pipe,
} from "effect"
import { RepositoryStore } from "effect-domains/repository-store"
import { Database } from "effect-domains/sqlite-bun"
import {
  InsufficientStock,
  type Reservation,
  ReservationIdSchema,
  type ReservationInput,
  ReservationNotFound,
  type ReserveStockInput,
  type Stock,
  transitionReservation,
  UnknownSku,
} from "./domain.ts"
import { Inventory, InventoryUnavailable } from "./inventory.ts"
import { ReservationResource, StockResource } from "./resources.ts"

const persistenceFailure = Effect.fn("Inventory.persistenceFailure")(function* (
  cause: unknown,
) {
  yield* Effect.logError("Inventory persistence failed", cause)
  return yield* InventoryUnavailable.make({})
})

const persistenceErrors = {
  SqlError: persistenceFailure,
  RepositoryError: persistenceFailure,
}

export const seedStock = Effect.fn("InventorySqlite.seedStock")(function* (
  stock: Stock,
) {
  const existing = yield* StockResource.repository.find(stock.sku)
  if (Option.isNone(existing)) {
    yield* StockResource.repository.create(stock)
  }
})

const inventorySqliteEffect = Effect.gen(function* () {
  const database = yield* Database
  const repositories = yield* RepositoryStore

  const reserve = Effect.fn("Inventory.reserve")(function* (
    input: ReserveStockInput,
  ) {
    const reservationTransaction = Effect.gen(function* () {
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

      const generatedId = Bun.randomUUIDv7()

      const id = yield* Effect.try({
        try: () => ReservationIdSchema.make(generatedId),
        catch: () => InventoryUnavailable.make({}),
      })

      const createdAt = yield* DateTime.now
      return yield* ReservationResource.repository.create({
        id,
        sku: input.sku,
        quantity: input.quantity,
        status: "held",
        createdAt,
      })
    })

    const transaction = database.withTransaction(reservationTransaction)

    return yield* pipe(
      transaction,
      Effect.catchTags(persistenceErrors),
      Effect.provideService(RepositoryStore, repositories),
    )
  })

  const restoreStock = Effect.fn("Inventory.restoreStock")(function* (
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
      yield* Effect.logError("Reservation release could not restore stock")
      return yield* InventoryUnavailable.make({})
    }
  })

  const transition = (action: "confirm" | "release") =>
    Effect.fn("Inventory.transition")(function* (input: ReservationInput) {
      const transitionTransaction = Effect.gen(function* () {
        const reservation = yield* ReservationResource.repository.find(input.id)
        if (Option.isNone(reservation)) {
          return yield* ReservationNotFound.make({ id: input.id })
        }

        const next = yield* transitionReservation(reservation.value, action)
        if (Equivalence.strictEqual<typeof action>()(action, "release")) {
          yield* restoreStock(next)
        }

        return yield* pipe(
          ReservationResource.repository.update(next),
          Effect.catchTag("ResourceNotFound", persistenceFailure),
        )
      })

      const transaction = database.withTransaction(transitionTransaction)

      return yield* pipe(
        transaction,
        Effect.catchTags(persistenceErrors),
        Effect.provideService(RepositoryStore, repositories),
      )
    })

  return Inventory.of({
    reserve,
    confirm: transition("confirm"),
    release: transition("release"),
  })
})

export const InventorySqlite = Layer.effect(Inventory, inventorySqliteEffect)
