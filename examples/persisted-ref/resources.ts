import { Resource } from "effect-domains/resource"
import { CounterSchema } from "./domain.ts"

export const CounterResource = Resource.make({
  name: "counters",
  schema: CounterSchema,
  operations: [],
})
