import { Schema } from "effect"
import { CalendarDateSchema } from "effect-domains/domain"

export const TaskPrioritySchema = Schema.Literals(["low", "normal", "high", "urgent"])

export const TaskSchema = Schema.Struct({
  project: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  detail: Schema.NullOr(Schema.String),
  priority: TaskPrioritySchema,
  dueDate: Schema.NullOr(CalendarDateSchema),
  completed: Schema.Boolean,
  tenantId: Schema.String,
  ownerId: Schema.String,
})

