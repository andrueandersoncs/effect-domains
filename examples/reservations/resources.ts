import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"

import {
  ReservationSchema,
  ReservationStateTransitions,
  StockSchema,
} from "./domain.ts"

export const StockResource = Resource.make({
  authorization: Authorization.public,
  name: "stock",
  schema: StockSchema,
  operations: { get: true },
})

export const ReservationResource = Resource.make({
  authorization: Authorization.public,
  name: "reservations",
  schema: ReservationSchema,
  transitions: ReservationStateTransitions,
  operations: {
    get: true,
    create: {
      defaults: { status: "held" },
      generated: { id: "uuidV7", createdAt: "now" },
      publish: false,
    },
  },
})
