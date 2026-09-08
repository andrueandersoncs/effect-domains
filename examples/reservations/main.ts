import { BunRuntime } from "@effect/platform-bun"
import { ApplicationBun } from "effect-domains/application-bun"
import { ReservationApplication } from "./application.ts"
import { SkuSchema, StockSchema } from "./domain.ts"
import { InventorySqlite, seedStock } from "./sqlite.ts"

const InitialStock = StockSchema.make({
  sku: SkuSchema.make("book"),
  available: 5,
})
const manifest = Bun.fileURLToPath(new URL("./migrations/manifest.json", import.meta.url))

BunRuntime.runMain(ApplicationBun.run(ReservationApplication, {
  database: { manifest },
  services: InventorySqlite,
  initialize: seedStock(InitialStock),
}))
