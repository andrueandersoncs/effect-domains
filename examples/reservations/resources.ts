import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"

import {
  ReservationSchema,
  ReservationStateTransitions,
  StockSchema,
} from "./domain.ts"

export const StockResource = Resource.define({
  authorization: Authorization.public,
  name: "stock",
  schema: StockSchema,
  capabilities: Resource.capabilities(Resource.get()),
})

export const ReservationResource = Resource.define({
  authorization: Authorization.public,
  name: "reservations",
  schema: ReservationSchema,
  transitions: ReservationStateTransitions,
  capabilities: Resource.capabilities(
    Resource.get(),
    Resource.create({
      sources: {
        status: Resource.default("held"),
        id: Resource.generated("uuidV7"),
        createdAt: Resource.generated("now"),
      },
      publish: false,
    }),
  ),
})
