import { Effect, Number, Struct, pipe } from "effect"
import { PersistedRef } from "effect-domains/persisted-ref"
import { CounterCommands, type SetCounterPayload } from "./contracts.ts"
import {
  type Counter as CounterValue,
  CounterSchema,
  CounterUnavailable,
  VisitsCounterId,
} from "./domain.ts"
import { CounterResource } from "./resources.ts"

const unavailable = () => CounterUnavailable.make({})

const persistence = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  pipe(effect, Effect.mapError(unavailable))

const incrementedValue = Struct.evolve<
  CounterValue,
  { readonly value: typeof Number.increment }
>({ value: Number.increment })

const counterHandlers = Effect.gen(function* () {
  const persisted = yield* PersistedRef.fromResource(CounterResource, {
    key: VisitsCounterId,
    ifMissing: { value: 0 },
  })

  const get = Effect.fn("Counter.get")(function* () {
    return yield* persisted.get
  })

  const increment = Effect.fn("Counter.increment")(function* () {
    const updated = persisted.update(incrementedValue)
    return yield* persistence(updated)
  })

  // Bypass the cache because refresh makes the external write visible.
  const set = Effect.fn("Counter.set")(function* ({ value }: SetCounterPayload) {
    const next = CounterSchema.make({ id: VisitsCounterId, value })
    const updated = CounterResource.repository.update(next)
    return yield* persistence(updated)
  })

  const refresh = Effect.fn("Counter.refresh")(function* () {
    return yield* persistence(persisted.refresh)
  })

  return {
    "counters.get": get,
    "counters.increment": increment,
    "counters.set": set,
    "counters.refresh": refresh,
  }
})

export const CounterSqlite = CounterCommands.layer(counterHandlers)
