import { Authorization } from "effect-domains/authorization"
import { expect, it } from "@effect/vitest"
import { Effect, Option, Result, pipe } from "effect"
import { CounterIdSchema, CounterSchema, type Counter, VisitsCounterId } from "../apps/persisted-ref/domain.ts"
import { PersistedRef } from "effect-domains/persisted-ref"
import { Resource } from "effect-domains/resource"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { prepareTables } from "./prepare-tables.ts"

const incrementCounter = (row: Counter) => CounterSchema.make({ ...row, value: row.value + 1 })
const Counters = Resource.make({ authorization: Authorization.public, name: "reference_counters", schema: CounterSchema, operations: [] })
const otherCounterId = CounterIdSchema.make("other")

const otherCounter = CounterSchema.make({
  id: otherCounterId,
  value: 99,
})

const redirectedCounter = CounterSchema.make({
  id: otherCounterId,
  value: 7,
})

const updatedVisitsCounter = CounterSchema.make({
  id: VisitsCounterId,
  value: 10,
})

const sqlite = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })

const persistedResourceProgram = Effect.gen(function* () {
  yield* prepareTables([Counters.table])

  const ref = yield* PersistedRef.fromResource(Counters, {
    key: VisitsCounterId,
    ifMissing: { value: 0 },
  })

  yield* Counters.repository.create(otherCounter)
  yield* ref.update(incrementCounter)

  const redirection = ref.set(redirectedCounter)
  const redirected = yield* Effect.result(redirection)
  const redirectionFailed = Result.isFailure(redirected)
  expect(redirectionFailed).toBe(true)
  if (redirectionFailed) {
    expect(redirected.failure._tag).toBe("PersistedRefKeyError")
  }

  const visits = yield* ref.get
  expect(visits).toEqual({ id: "visits", value: 1 })
  const other = yield* Counters.repository.get(otherCounterId)
  expect(other).toEqual({ id: "other", value: 99 })

  yield* Counters.repository.update(updatedVisitsCounter)
  const cachedVisits = yield* ref.get
  expect(cachedVisits).toEqual({ id: "visits", value: 1 })
  const refreshedVisits = yield* ref.refresh
  expect(refreshedVisits).toEqual({ id: "visits", value: 10 })

  yield* Counters.repository.remove(VisitsCounterId)
  const refreshed = yield* Effect.result(ref.refresh)
  const refreshFailed = Result.isFailure(refreshed)
  expect(refreshFailed).toBe(true)
  if (refreshFailed) {
    expect(refreshed.failure._tag).toBe("ResourceNotFound")
  }
  const retainedVisits = yield* ref.get
  expect(retainedVisits).toEqual({ id: "visits", value: 10 })
  const missing = yield* Counters.repository.find(VisitsCounterId)
  const visitsAreMissing = Option.isNone(missing)
  expect(visitsAreMissing).toBe(true)
})

it.effect("a resource reference cannot redirect writes or recreate a deleted row on refresh", () => pipe(persistedResourceProgram, Effect.provide(sqlite)))
