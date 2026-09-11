import { Schema, pipe } from "effect"
import { identifier } from "effect-domains/domain"

export const WorkshopIdSchema = pipe(Schema.NonEmptyString, identifier)
export const RepairStatusSchema = Schema.Literals(["queued", "repairing", "ready"])

export const CustomerSchema = Schema.Struct({
  id: WorkshopIdSchema,
  name: Schema.NonEmptyString,
})

export const TechnicianSchema = Schema.Struct({
  id: WorkshopIdSchema,
  name: Schema.NonEmptyString,
  onCall: Schema.Boolean,
})

export const RepairJobSchema = Schema.Struct({
  customerId: Schema.NonEmptyString,
  item: Schema.NonEmptyString,
  fault: Schema.NonEmptyString,
  urgent: Schema.Boolean,
  status: RepairStatusSchema,
  technicianId: Schema.NullOr(Schema.NonEmptyString),
})

export const RepairBoardInputSchema = Schema.Struct({
  status: Schema.optionalKey(RepairStatusSchema),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
})

export class RepairWorkshopUnavailable extends Schema.TaggedError<RepairWorkshopUnavailable>()(
  "RepairWorkshopUnavailable",
  {},
) {}
