import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ReservationApplication } from "./application.ts"
import { SkuSchema, StockSchema } from "./domain.ts"
import { InventoryMigrations } from "./migrations.ts"
import { seedStock } from "./sqlite.ts"

const InitialStock = StockSchema.make({
  sku: SkuSchema.make("book"),
  available: 5,
})


const seed = seedStock(InitialStock)

const program = ApplicationBun.run(ReservationApplication, {
  database: { migrations: InventoryMigrations },
  initialize: seed,
  ui: {
    presentation: {
      title: "Reservations",
      description: "Reserve stock, then confirm or release the guarded hold.",
    },
  },
})

pipe(program, ApplicationBun.runMain)
