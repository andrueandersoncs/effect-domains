import { ApplicationBun } from "effect-domains/application-bun"
import { ReservationApplication } from "./application.ts"
import { SkuSchema, StockSchema } from "./domain.ts"
import { InventorySqlite, seedStock } from "./sqlite.ts"

const InitialStock = StockSchema.make({
  sku: SkuSchema.make("book"),
  available: 5,
})

const manifest = new URL("./migrations/manifest.json", import.meta.url)
const initialize = seedStock(InitialStock)

ApplicationBun.runMain(ReservationApplication, {
  database: { manifest },
  services: InventorySqlite,
  initialize,
  admin: true,
})
