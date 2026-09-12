import { Schema, pipe } from "effect"
import { identifier } from "effect-domains/domain"
import { Transitions } from "effect-domains/transitions"

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

// Repairs only move forward because a ready job is handed back, never re-queued.
export const RepairJobTransitions = Transitions.make({
  name: "RepairJob",
  field: "status",
  status: RepairStatusSchema,
  transitions: {
    start: { from: ["queued"], to: "repairing" },
    finish: { from: ["repairing"], to: "ready" },
  },
})


export class RepairWorkshopUnavailable extends Schema.TaggedError<RepairWorkshopUnavailable>()(
  "RepairWorkshopUnavailable",
  {},
) {}
