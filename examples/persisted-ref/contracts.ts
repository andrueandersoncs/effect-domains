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

const getCounter = Commands.rpc("counters.get", counterOperation)
const incrementCounter = Commands.rpc("counters.increment", counterOperation)
const setCounter = Commands.rpc("counters.set", {
  ...counterOperation,
  payload: SetCounterPayloadSchema,
})
const refreshCounter = Commands.rpc("counters.refresh", counterOperation)

const counterRpcs = RpcGroup.make(
  getCounter,
  incrementCounter,
  setCounter,
  refreshCounter,
)

export const CounterCommands = Commands.make({
  name: "examples/persisted-ref/Counter",
  group: counterRpcs,
})
