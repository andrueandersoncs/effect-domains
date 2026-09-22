import { Application, Part } from "effect-domains/application"
import { ReservationResource, StockResource } from "./resources.ts"
import { InventoryOperations } from "./sqlite.ts"
import { Effect } from "effect"

const parts = [Part.resource(StockResource), Part.resource(ReservationResource), Part.command(InventoryOperations)]
const reservations = Application.define({ name: "reservations", parts })
export const ReservationApplication = Effect.runSync(Application.compile(reservations))
