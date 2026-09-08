import {
  Array,
  Effect,
  Layer,
  Number,
  Option,
  Schema,
  Struct,
  pipe,
} from "effect"
import { SchemaStore } from "effect-domains/migrations"
import { PersistedRef } from "effect-domains/persisted-ref"
import { Query } from "effect-domains/query"
import { Database } from "effect-domains/sqlite-bun"
import { Table } from "effect-domains/table"
import { Counter, CounterUnavailable } from "./counter.ts"
import type { SetCounterPayload } from "./contracts.ts"
import {
  type Counter as CounterValue,
  CounterIdSchema,
  CounterSchema,
  VisitsCounterId,
} from "./domain.ts"
import { CounterResource } from "./resources.ts"

const OptionalCounterSchema = Schema.OptionFromNullOr(CounterSchema)

const createCounter = Effect.fn("CounterQueries.create")(function* (
  counter: typeof CounterSchema.Encoded,
) {
  const database = yield* Database

  const rows = yield* database<Readonly<Record<string, unknown>>>`
    INSERT INTO ${database(CounterResource.table.name)} ${database.insert(counter)}
    RETURNING *
  `

  return pipe(rows, Array.get(0), Option.getOrUndefined)
})

const CreateCounter = Query.make({
  table: CounterResource.table,
  Request: CounterSchema,
  Result: CounterSchema,
  implementation: createCounter,
})

const findCounter = Effect.fn("CounterQueries.find")(function* (
  id: typeof CounterIdSchema.Encoded,
) {
  const database = yield* Database

  const rows = yield* database<Readonly<Record<string, unknown>>>`
    SELECT * FROM ${database(CounterResource.table.name)}
    WHERE ${database(CounterResource.table.identifier)} = ${id}
    LIMIT 1
  `

  return pipe(rows, Array.get(0), Option.getOrNull)
})

const FindCounter = Query.make({
  table: CounterResource.table,
  Request: CounterIdSchema,
  Result: OptionalCounterSchema,
  implementation: findCounter,
})

const updateCounter = Effect.fn("CounterQueries.update")(function* (
  counter: typeof CounterSchema.Encoded,
) {
  const database = yield* Database
  const id = counter[CounterResource.table.identifier]
  const changes = database.update(counter, [CounterResource.table.identifier])

  const rows = yield* database<Readonly<Record<string, unknown>>>`
    UPDATE ${database(CounterResource.table.name)}
    SET ${changes}
    WHERE ${database(CounterResource.table.identifier)} = ${id}
    RETURNING *
  `

  return pipe(rows, Array.get(0), Option.getOrNull)
})

const UpdateCounter = Query.make({
  table: CounterResource.table,
  Request: CounterSchema,
  Result: OptionalCounterSchema,
  implementation: updateCounter,
})

const unavailable = () => CounterUnavailable.make({})

const persistence = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  pipe(effect, Effect.mapError(unavailable))

const requireCounter = <E, R>(
  effect: Effect.Effect<Option.Option<CounterValue>, E, R>,
) =>
  Effect.flatMap(effect, (counter) =>
    Option.match(counter, {
      onNone: unavailable,
      onSome: Effect.succeed,
    }),
  )

const seedVisitsCounter = Effect.fn("CounterSqlite.seedVisitsCounter")(
  function* () {
    const existing = yield* FindCounter.execute(VisitsCounterId)
    if (Option.isNone(existing)) {
      const initial = CounterSchema.make({ id: VisitsCounterId, value: 0 })
      yield* CreateCounter.execute(initial)
    }
  },
)

const incrementedValue = Struct.evolve<
  CounterValue,
  { readonly value: typeof Number.increment }
>({ value: Number.increment })

const counterSqliteEffect = Effect.gen(function* () {
  const database = yield* Database

  const query = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Database, database)

  const schemaStore = yield* SchemaStore
  const snapshot = Table.snapshot(CounterResource.table)
  yield* pipe(schemaStore.prepare([snapshot]), persistence)
  yield* pipe(seedVisitsCounter(), query, persistence)

  const load = pipe(
    FindCounter.execute(VisitsCounterId),
    requireCounter,
    query,
    persistence,
  )

  const commit = (_previous: CounterValue, next: CounterValue) =>
    pipe(UpdateCounter.execute(next), requireCounter, query, persistence)

  const persisted = yield* PersistedRef.make({ load, commit })

  const get = Effect.fn("Counter.get")(function* () {
    return yield* persisted.get
  })

  const increment = Effect.fn("Counter.increment")(function* () {
    return yield* pipe(persisted.update(incrementedValue), persistence)
  })

  const set = Effect.fn("Counter.set")(function* ({
    value,
  }: SetCounterPayload) {
    const next = CounterSchema.make({ id: VisitsCounterId, value })
    return yield* pipe(
      UpdateCounter.execute(next),
      requireCounter,
      query,
      persistence,
    )
  })

  const refresh = Effect.fn("Counter.refresh")(function* () {
    return yield* pipe(persisted.refresh, persistence)
  })

  return Counter.of({
    "counters.get": get,
    "counters.increment": increment,
    "counters.set": set,
    "counters.refresh": refresh,
  })
})

export const CounterSqlite = Layer.effect(Counter, counterSqliteEffect)
