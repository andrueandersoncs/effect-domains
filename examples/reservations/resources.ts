import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"

import {
  ReservationSchema,
  ReservationStateTransitions,
  StockSchema,
} from "./domain.ts"

const stockCapabilities = [Resource.get()]

export const StockResource = Resource.define({
  authorization: Authorization.public,
  name: "stock",
  schema: StockSchema,
  capabilities: stockCapabilities,
})

const reservationCreateSources = {
  status: Resource.default("held"),
  id: Resource.generated("uuidV7"),
  createdAt: Resource.generated("now"),
}

const reservationCapabilities = [
  Resource.get(),
  Resource.create({
    sources: reservationCreateSources,
    publish: false,
  }),
]

export const ReservationResource = Resource.define({
  authorization: Authorization.public,
  name: "reservations",
  schema: ReservationSchema,
  transitions: ReservationStateTransitions,
  capabilities: reservationCapabilities,
})
