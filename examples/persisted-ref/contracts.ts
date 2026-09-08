import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { CounterUnavailable } from "./counter.ts"
import { CounterSchema } from "./domain.ts"

const EmptyPayloadSchema = Schema.Struct({})

interface EmptyPayload extends Schema.Schema.Type<typeof EmptyPayloadSchema> {}

const SetCounterPayloadSchema = Schema.Struct({ value: Schema.Number })

export interface SetCounterPayload extends Schema.Schema.Type<
  typeof SetCounterPayloadSchema
> {}

const getCounter = Rpc.make("counters.get", {
  payload: EmptyPayloadSchema,
  success: CounterSchema,
  error: CounterUnavailable,
})

const incrementCounter = Rpc.make("counters.increment", {
  payload: EmptyPayloadSchema,
  success: CounterSchema,
  error: CounterUnavailable,
})

const setCounter = Rpc.make("counters.set", {
  payload: SetCounterPayloadSchema,
  success: CounterSchema,
  error: CounterUnavailable,
})

const refreshCounter = Rpc.make("counters.refresh", {
  payload: EmptyPayloadSchema,
  success: CounterSchema,
  error: CounterUnavailable,
})

export const CounterCommands = RpcGroup.make(
  getCounter,
  incrementCounter,
  setCounter,
  refreshCounter,
)
