import { Application } from "effect-domains/application"
import { ReservationResource, StockResource } from "./resources.ts"
import { InventoryOperations } from "./sqlite.ts"

export const ReservationApplication = Application.make({
  name: "reservations",
  parts: [StockResource, ReservationResource, InventoryOperations],
})
