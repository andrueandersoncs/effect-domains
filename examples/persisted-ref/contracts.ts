import { Schema } from "effect"
import { Commands, type CommandContract } from "effect-domains/commands"
import { CounterSchema, CounterUnavailable } from "./domain.ts"

const SetCounterPayloadSchema = Schema.Struct({ value: Schema.Number })

export interface SetCounterPayload extends Schema.Schema.Type<
  typeof SetCounterPayloadSchema
> {}

const counterOperation = {
  input: Schema.Struct({}),
  output: CounterSchema,
  error: CounterUnavailable,
} satisfies CommandContract

export const CounterCommands = Commands.make("examples/persisted-ref/Counter", {
  "counters.get": counterOperation,
  "counters.increment": counterOperation,
  "counters.set": {
    input: SetCounterPayloadSchema,
    output: CounterSchema,
    error: CounterUnavailable,
  },
  "counters.refresh": counterOperation,
})
