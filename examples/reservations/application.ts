import { Effect } from "effect"
import { Application } from "../../src/application.ts"
import { ReservationCommands } from "./contracts.ts"
import { Inventory } from "./inventory.ts"
import { ReservationResource, StockResource } from "./resources.ts"

export const ReservationApplication = Application.make({
  name: "reservations",
  resources: [StockResource, ReservationResource],
  commands: ReservationCommands,
})

const reservationHandlersEffect = Effect.gen(function* () {
  return yield* Inventory
})

export const ReservationHandlers = ReservationApplication.toLayer(
  reservationHandlersEffect,
)
