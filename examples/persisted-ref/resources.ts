import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { CounterSchema } from "./domain.ts"

export const CounterResource = Resource.make({ authorization: Authorization.public, name: "counters", schema: CounterSchema, operations: [] })
