import { pipe } from "effect"
import { StaticSpa } from "effect-domains/static-spa"
import { ApplicationBun } from "effect-domains/application-bun"
import { ReservationApplication } from "./application.ts"
import { SkuSchema, StockSchema } from "./domain.ts"
import { InventoryMigrations } from "./migrations.ts"
import { seedStock } from "./sqlite.ts"

const InitialStock = StockSchema.make({
  sku: SkuSchema.make("book"),
  available: 5,
})

const webBase = new URL("./web/", import.meta.url)
const web = StaticSpa.layerHttp({ title: "Reservations", accent: "#b45309", base: webBase })

const seed = seedStock(InitialStock)

const program = ApplicationBun.run(ReservationApplication, {
  database: { migrations: InventoryMigrations },
  initialize: seed,
  admin: true,
  routes: web,
})

pipe(program, ApplicationBun.runMain)
