import { expect, it } from "@effect/vitest"
import { Effect, Option, Result, Schema } from "effect"
import { identifier } from "../src/domain.ts"
import { PersistedRef } from "../src/persisted-ref.ts"
import { Resource } from "../src/resource.ts"
import { SqliteBunRuntime } from "../src/sqlite-bun.ts"
import { prepareTables } from "./prepare-tables.ts"

const Counters = Resource.make({
  name: "reference_counters",
  schema: Schema.Struct({ id: identifier(Schema.String), value: Schema.Int }),
  operations: [],
})

it.effect("a resource reference cannot redirect writes or recreate a deleted row on refresh", () =>
  Effect.gen(function* () {
    yield* prepareTables([Counters.table])
    const ref = yield* PersistedRef.fromResource(Counters, {
      key: "visits",
      ifMissing: { value: 0 },
    })
    yield* Counters.repository.create({ id: "other", value: 99 })
    yield* ref.update((row) => ({ ...row, value: row.value + 1 }))
    const redirected = yield* Effect.result(ref.set({ id: "other", value: 7 }))
    expect(Result.isFailure(redirected)).toBe(true)
    if (Result.isFailure(redirected)) {
      expect(redirected.failure._tag).toBe("PersistedRefKeyError")
    }
    expect(yield* ref.get).toEqual({ id: "visits", value: 1 })
    expect(yield* Counters.repository.get("other")).toEqual({ id: "other", value: 99 })

    yield* Counters.repository.update({ id: "visits", value: 10 })
    expect(yield* ref.get).toEqual({ id: "visits", value: 1 })
    expect(yield* ref.refresh).toEqual({ id: "visits", value: 10 })

    yield* Counters.repository.remove("visits")
    const refreshed = yield* Effect.result(ref.refresh)
    expect(Result.isFailure(refreshed)).toBe(true)
    if (Result.isFailure(refreshed)) {
      expect(refreshed.failure._tag).toBe("ResourceNotFound")
    }
    expect(yield* ref.get).toEqual({ id: "visits", value: 10 })
    expect(Option.isNone(yield* Counters.repository.find("visits"))).toBe(true)
  }).pipe(Effect.provide(SqliteBunRuntime.sqlClient(":memory:", { migrations: [] }))),
)
