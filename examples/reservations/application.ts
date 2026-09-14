import { Application, Part } from "effect-domains/application"
import { ReservationResource, StockResource } from "./resources.ts"
import { InventoryOperations } from "./sqlite.ts"

export const ReservationApplication = Application.compile(Application.define({
  name: "reservations",
  parts: [Part.resource(StockResource), Part.resource(ReservationResource), Part.command(InventoryOperations)],
}))
