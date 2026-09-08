import { Resource } from "effect-domains/resource"
import { ReservationSchema, StockSchema } from "./domain.ts"

export const StockResource = Resource.make({
  name: "stock",
  schema: StockSchema,
  operations: ["get"],
})

export const ReservationResource = Resource.make({
  name: "reservations",
  schema: ReservationSchema,
  operations: ["get"],
})
