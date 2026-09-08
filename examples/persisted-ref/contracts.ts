import { Schema } from "effect"
import type { CommandContract, CommandContracts } from "effect-domains/application"
import { CounterUnavailable } from "./counter.ts"
import { CounterSchema } from "./domain.ts"

const SetCounterPayloadSchema = Schema.Struct({ value: Schema.Number })

export interface SetCounterPayload extends Schema.Schema.Type<
  typeof SetCounterPayloadSchema
> {}

const counterOperation = {
  input: Schema.Struct({}),
  output: CounterSchema,
  error: CounterUnavailable,
} satisfies CommandContract

export const CounterCommands = {
  "counters.get": counterOperation,
  "counters.increment": counterOperation,
  "counters.set": {
    input: SetCounterPayloadSchema,
    output: CounterSchema,
    error: CounterUnavailable,
  },
  "counters.refresh": counterOperation,
} satisfies CommandContracts
