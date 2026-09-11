import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ExampleWeb } from "@effect-domains/example-web/serve"
import { ApplicationBun } from "effect-domains/application-bun"
import { ReservationApplication } from "./application.ts"
import { SkuSchema, StockSchema } from "./domain.ts"
import { InventoryMigrations } from "./migrations.ts"
import { seedStock } from "./sqlite.ts"
import { ReservationsWebAssets } from "./web/assets.ts"

const InitialStock = StockSchema.make({
  sku: SkuSchema.make("book"),
  available: 5,
})

const web = ExampleWeb.layerHttp({
  title: "Reservations",
  accent: "#b45309",
  ...ReservationsWebAssets,
})

const seed = seedStock(InitialStock)

pipe(ApplicationBun.run(ReservationApplication, {
  database: { migrations: InventoryMigrations },
  initialize: seed,
  admin: true,
  routes: web,
}), BunRuntime.runMain)
