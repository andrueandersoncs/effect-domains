import { Schema, pipe } from "effect"
import { identifier } from "effect-domains/domain"

export const CounterIdSchema = pipe(
  Schema.String,
  Schema.brand("CounterId"),
  identifier,
)

export const CounterSchema = Schema.Struct({
  id: CounterIdSchema,
  value: Schema.Number,
})

export interface Counter extends Schema.Schema.Type<typeof CounterSchema> {}

export const VisitsCounterId = CounterIdSchema.make("visits")
