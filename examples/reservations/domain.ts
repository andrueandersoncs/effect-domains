import { Effect, Schema, pipe } from "effect"
import { identifier } from "effect-domains/domain"

export const SkuSchema = pipe(Schema.NonEmptyString, Schema.brand("Sku"))

const isReservationId = Schema.isUUID(7)

const reservationIdStringSchema = Schema.String.check(isReservationId)

export const ReservationIdSchema = pipe(
  reservationIdStringSchema,
  Schema.brand("ReservationId"),
  identifier,
)

const isNonNegative = Schema.isGreaterThanOrEqualTo(0)
const isSafeInteger = Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)

export const StockCountSchema = Schema.Int.check(isNonNegative, isSafeInteger)

const isPositive = Schema.isGreaterThan(0)

export const QuantitySchema = StockCountSchema.check(isPositive)

export const ReservationStatusSchema = Schema.Literals([
  "held",
  "confirmed",
  "released",
])

const IdentifiedSkuSchema = pipe(SkuSchema, identifier)

export const StockSchema = Schema.Struct({
  sku: IdentifiedSkuSchema,
  available: StockCountSchema,
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
  { sku: SkuSchema, requested: QuantitySchema, available: StockCountSchema },
) {}

export class ReservationNotFound extends Schema.TaggedError<ReservationNotFound>()(
  "ReservationNotFound",
  { id: ReservationIdSchema },
) {}

export const ReservationActionSchema = Schema.Literals(["confirm", "release"])

export class InvalidReservationState extends Schema.TaggedError<InvalidReservationState>()(
  "InvalidReservationState",
  {
    id: ReservationIdSchema,
    action: ReservationActionSchema,
    actual: ReservationStatusSchema,
  },
) {}

const TransitionSchema = Schema.Struct({
  from: ReservationStatusSchema,
  to: ReservationStatusSchema,
})

interface Transition extends Schema.Schema.Type<typeof TransitionSchema> {}

export const ReservationTransitions = Schema.Struct({
  confirm: TransitionSchema,
  release: TransitionSchema,
}).make({
  confirm: { from: "held", to: "confirmed" },
  release: { from: "held", to: "released" },
})

export const transitionReservation = Effect.fn("Reservation.transition")(
  function* (
    reservation: Reservation,
    action: typeof ReservationActionSchema.Type,
  ) {
    const transition = ReservationTransitions[action]
    if (reservation.status !== transition.from) {
      return yield* InvalidReservationState.make({
        id: reservation.id,
        action,
        actual: reservation.status,
      })
    }
    return ReservationSchema.make({ ...reservation, status: transition.to })
  },
)
