import { BunRuntime } from "@effect/platform-bun"
import { Effect, Option } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ReservationApplication } from "./application.ts"
import { SkuSchema, StockSchema } from "./domain.ts"
import { InventorySqlite, seedStock } from "./sqlite.ts"

const InitialStock = StockSchema.make({
  sku: SkuSchema.make("book"),
  available: 5,
})

const manifestUrl = new URL("./migrations/manifest.json", import.meta.url)
const manifest = Bun.fileURLToPath(manifestUrl)
const initialize = seedStock(InitialStock)
const filename = Option.none()

const program = ApplicationBun.run(ReservationApplication, {
  database: { manifest, filename },
  services: InventorySqlite,
  initialize,
})

BunRuntime.runMain(program)
