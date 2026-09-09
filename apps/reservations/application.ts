import { Application } from "effect-domains/application"
import { InventoryRpcs } from "./contracts.ts"
import { InventorySqlite } from "./sqlite.ts"
import { ReservationResource, StockResource } from "./resources.ts"

export const ReservationApplication = Application.make({
  name: "reservations",
  resources: [StockResource, ReservationResource],
  commands: [{ group: InventoryRpcs, handlers: InventorySqlite }],
})
