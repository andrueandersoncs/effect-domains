import { BunRuntime } from "@effect/platform-bun"
import { Config, Effect, Schema, pipe } from "effect"
import { ApplicationBun } from "../../src/application-bun.ts"
import { SqliteBunRuntime } from "../../src/sqlite-bun.ts"
import { ReservationApplication, ReservationHandlers } from "./application.ts"
import { SkuSchema, StockSchema } from "./domain.ts"
import { InventoryMigrations } from "./migrations.ts"
import { InventorySqlite, seedStock } from "./sqlite.ts"

const initialSku = SkuSchema.make("book")

const InitialStock = StockSchema.make({
  sku: initialSku,
  available: 5,
})

const reservationServer = Effect.gen(function* () {
  const filename = yield* pipe(
    Config.schema(Schema.NonEmptyString, "RESERVATIONS_DB"),
    Config.withDefault("reservations.sqlite"),
  )

  const runtime = SqliteBunRuntime.sqlClient(filename, {
    migrations: InventoryMigrations,
  })

  const initialize = seedStock(InitialStock)

  yield* ApplicationBun.serve({
    application: ReservationApplication,
    handlers: ReservationHandlers,
    runtime,
    services: InventorySqlite,
    initialize,
  })
})

BunRuntime.runMain(reservationServer as Effect.Effect<void, any>)
