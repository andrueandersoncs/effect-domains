import { Application } from "effect-domains/application"
import { Inventory } from "./contracts.ts"
import { ReservationResource, StockResource } from "./resources.ts"

export const ReservationApplication = Application.make({
  name: "reservations",
  resources: [StockResource, ReservationResource],
  commands: [Inventory],
})
