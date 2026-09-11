import { Schema, pipe } from "effect"

import {
  identifier,
  NonNegativeSafeIntSchema,
  UuidV7Schema,
} from "effect-domains/domain"

import { Transitions } from "effect-domains/transitions"

export const SkuSchema = pipe(Schema.NonEmptyString, Schema.brand("Sku"))

export const ReservationIdSchema = pipe(
  UuidV7Schema,
  Schema.brand("ReservationId"),
  identifier,
)

export const QuantitySchema = NonNegativeSafeIntSchema.check(
  Schema.isGreaterThan(0),
)

export const ReservationStatusSchema = Schema.Literals([
  "held",
  "confirmed",
  "released",
])

const IdentifiedSkuSchema = pipe(SkuSchema, identifier)

export const StockSchema = Schema.Struct({
  sku: IdentifiedSkuSchema,
  available: NonNegativeSafeIntSchema,
})

export interface Stock extends Schema.Schema.Type<typeof StockSchema> {}

export const ReservationSchema = Schema.Struct({
  id: ReservationIdSchema,
  sku: SkuSchema,
  quantity: QuantitySchema,
  status: ReservationStatusSchema,
  createdAt: Schema.DateTimeUtc,
})

export interface Reservation extends Schema.Schema.Type<
  typeof ReservationSchema
> {}

export const ReserveStockInputSchema = Schema.Struct({
  sku: SkuSchema,
  quantity: QuantitySchema,
})

export interface ReserveStockInput extends Schema.Schema.Type<
  typeof ReserveStockInputSchema
> {}

export const ReservationInputSchema = Schema.Struct({ id: ReservationIdSchema })

export interface ReservationInput extends Schema.Schema.Type<
  typeof ReservationInputSchema
> {}

export class UnknownSku extends Schema.TaggedError<UnknownSku>()("UnknownSku", {
  sku: SkuSchema,
}) {}

export class InsufficientStock extends Schema.TaggedError<InsufficientStock>()(
  "InsufficientStock",
  { sku: SkuSchema, requested: QuantitySchema, available: NonNegativeSafeIntSchema },
) {}

export class InventoryUnavailable extends Schema.TaggedError<InventoryUnavailable>()(
  "InventoryUnavailable",
  {},
) {}

export const ReservationStateTransitions = Transitions.make({
  name: "Reservation",
  field: "status",
  status: ReservationStatusSchema,
  transitions: {
    confirm: { from: ["held"], to: "confirmed" },
    release: { from: ["held"], to: "released" },
  },
})
