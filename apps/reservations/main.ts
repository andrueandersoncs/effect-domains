import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ReservationApplication } from "./application.ts"
import { SkuSchema, StockSchema } from "./domain.ts"
import { seedStock } from "./sqlite.ts"
import { InventoryMigrations } from "./migrations.ts"

const InitialStock = StockSchema.make({
  sku: SkuSchema.make("book"),
  available: 5,
})

const initialize = seedStock(InitialStock)

pipe(ApplicationBun.run(ReservationApplication, {
  database: { migrations: InventoryMigrations },
  initialize,
  admin: true,
}), BunRuntime.runMain)
