import { Schema } from "effect"
import { RpcGroup } from "effect/unstable/rpc"
import { Commands } from "effect-domains/commands"
import { CounterSchema, CounterUnavailable } from "./domain.ts"

const SetCounterPayloadSchema = Schema.Struct({ value: Schema.Number })

export interface SetCounterPayload extends Schema.Schema.Type<
  typeof SetCounterPayloadSchema
> {}

const counterOperation = {
  payload: Schema.Struct({}),
  success: CounterSchema,
  error: CounterUnavailable,
}

const get = Commands.rpc("counters.get", counterOperation)
const increment = Commands.rpc("counters.increment", counterOperation)

const set = Commands.rpc("counters.set", {
  ...counterOperation,
  payload: SetCounterPayloadSchema,
})

const refresh = Commands.rpc("counters.refresh", counterOperation)
const counterRpcs = RpcGroup.make(get, increment, set, refresh)

export const CounterCommands = Commands.make({
  name: "examples/persisted-ref/Counter",
  group: counterRpcs,
})
