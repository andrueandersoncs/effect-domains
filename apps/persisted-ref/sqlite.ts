import { Effect, Function, Number, Struct } from "effect"
import { PersistedRef } from "effect-domains/persisted-ref"
import { CounterCommands, type SetCounterPayload } from "./contracts.ts"

import {
  type Counter as CounterValue,
  CounterSchema,
  CounterUnavailable,
  VisitsCounterId,
} from "./domain.ts"

import { CounterResource } from "./resources.ts"

const unavailable = Effect.fn("Counter.unavailable")(function* () {
  return yield* CounterUnavailable.make({})
})

const persistenceErrors = {
  PersistedRefKeyError: unavailable,
  RepositoryError: unavailable,
  ResourceNotFound: unavailable,
}

const incrementedValue = Struct.evolve<
  CounterValue,
  { readonly value: typeof Number.increment }
>({ value: Number.increment })

const counterHandlers = Effect.gen(function* () {
  const persisted = yield* PersistedRef.fromResource(CounterResource, {
    key: VisitsCounterId,
    ifMissing: { value: 0 },
  })

  const increment = Effect.fn("Counter.increment")(function* () {
    return yield* persisted.update(incrementedValue)
  })

  // Bypass the cache because refresh makes the external write visible.
  const set = Effect.fn("Counter.set")(function* ({ value }: SetCounterPayload) {
    const next = CounterSchema.make({ id: VisitsCounterId, value })
    return yield* CounterResource.repository.update(next)
  })

  return {
    "counters.get": Function.constant(persisted.get),
    "counters.increment": increment,
    "counters.set": set,
    "counters.refresh": Function.constant(persisted.refresh),
  }
})

export const CounterSqlite = CounterCommands.layer(counterHandlers, persistenceErrors)

