import { Application } from "effect-domains/application"
import { ReservationCommands } from "./contracts.ts"
import { Inventory } from "./inventory.ts"
import { ReservationResource, StockResource } from "./resources.ts"

export const ReservationApplication = Application.make({
  name: "reservations",
  resources: [StockResource, ReservationResource],
  commands: ReservationCommands,
})

export const ReservationHandlers = ReservationApplication.toLayer(Inventory)
