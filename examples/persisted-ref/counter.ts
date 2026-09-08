import { Context, Schema } from "effect"
import type { CommandService } from "effect-domains/application"
import type { CounterCommands } from "./contracts.ts"

export class CounterUnavailable extends Schema.TaggedError<CounterUnavailable>()(
  "CounterUnavailable",
  {},
) {}

export class Counter extends Context.Service<
  Counter,
  CommandService<typeof CounterCommands>
>()("examples/persisted-ref/Counter") {}
