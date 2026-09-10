import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ReservationSchema, StockSchema } from "./domain.ts"

export const StockResource = Resource.make({ authorization: Authorization.public, name: "stock", schema: StockSchema, operations: { get: true } })
export const ReservationResource = Resource.make({ authorization: Authorization.public, name: "reservations", schema: ReservationSchema, operations: { get: true } })
