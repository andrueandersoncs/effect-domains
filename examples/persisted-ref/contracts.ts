import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Commands } from "effect-domains/commands"
import { CounterSchema, CounterUnavailable } from "./domain.ts"

const SetCounterPayloadSchema = Schema.Struct({ value: Schema.Number })

export interface SetCounterPayload extends Schema.Schema.Type<
  typeof SetCounterPayloadSchema
> {}

const counterOperation = {
  payload: Schema.Struct({}),
  success: Schema.toCodecJson(CounterSchema),
  error: Schema.toCodecJson(CounterUnavailable),
}

const get = Rpc.make("counters.get", counterOperation)
const increment = Rpc.make("counters.increment", counterOperation)
const setPayloadSchema = Schema.toCodecJson(SetCounterPayloadSchema)

const set = Rpc.make("counters.set", {
  ...counterOperation,
  payload: setPayloadSchema,
})

const refresh = Rpc.make("counters.refresh", counterOperation)
const counterRpcs = RpcGroup.make(get, increment, set, refresh)

export const CounterCommands = Commands.make({
  name: "examples/persisted-ref/Counter",
  group: counterRpcs,
})
