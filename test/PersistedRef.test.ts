import { describe, expect, it } from "@effect/vitest"

import {
  Array,
  Effect,
  Function,
  pipe,
  Ref,
  Schema,
} from "effect"

import { PersistedRef } from "effect-domains/persisted-ref"

describe("PersistedRef", () => {
  const UpdateCountBounds = Schema.isBetween({ minimum: 1, maximum: 30 })
  const UpdateCountSchema = Schema.Int.check(UpdateCountBounds)

  const CachedValueBounds = Schema.isBetween({
    minimum: -1_000,
    maximum: 1_000,
  })

  const CachedValueSchema = Schema.Number.check(CachedValueBounds)
  const increment = (current: number) => current + 1

  const describeChange = (current: number) =>
    [`changed from ${current}`, current + 1.7] as const

  const verifiesSerializedUpdates = Effect.fn(
    "PersistedRefTest.verifiesSerializedUpdates",
  )(function* (updateCount: number) {
    const durable = yield* Ref.make(0)
    const load = Ref.get(durable)

    const commit = Effect.fn("PersistedRefTest.commit")(function* (
      _previous: number,
      next: number,
    ) {
      yield* Effect.yieldNow
      yield* Ref.set(durable, next)

      return next
    })

    const ref = yield* PersistedRef.make({ commit, load })
    const update = ref.update(increment)
    const updates = Array.makeBy(updateCount, Function.constant(update))

    yield* Effect.all(updates, { concurrency: "unbounded" })

    const cached = yield* ref.get
    const stored = yield* Ref.get(durable)

    expect(cached).toBe(updateCount)
    expect(stored).toBe(updateCount)

    yield* Ref.set(durable, updateCount + 1)

    const stale = yield* ref.get
    const refreshed = yield* ref.refresh

    expect(stale).toBe(updateCount)
    expect(refreshed).toBe(updateCount + 1)
    expect(yield* ref.get).toBe(updateCount + 1)
  })

  const failedLoad = Effect.succeed(1)

  const failCommit = Effect.fn("PersistedRefTest.failCommit")(function* (
    _previous: number,
    _next: number,
  ) {
    return yield* Effect.fail("commit failed" as const)
  })

  const verifiesFailedCommit = Effect.fn(
    "PersistedRefTest.verifiesFailedCommit",
  )(function* (next: number) {
    const ref = yield* PersistedRef.make({ commit: failCommit, load: failedLoad })

    const committed = yield* pipe(
      ref.set(next),
      Effect.match({
        onFailure: Function.constant(false),
        onSuccess: Function.constant(true),
      }),
    )

    expect(committed).toBe(false)
    expect(yield* ref.get).toBe(1)
  })

  const canonicalLoad = Effect.succeed(0)

  const roundCommit = Effect.fn("PersistedRefTest.roundCommit")(function* (
    _previous: number,
    next: number,
  ) {
    return Math.round(next)
  })

  const verifiesCanonicalResult = Effect.fn(
    "PersistedRefTest.verifiesCanonicalResult",
  )(function* (next: number) {
    const ref = yield* PersistedRef.make({ commit: roundCommit, load: canonicalLoad })

    yield* ref.set(next)

    const canonical = Math.round(next)

    expect(yield* ref.get).toBe(canonical)

    const result = yield* ref.modify(describeChange)

    expect(result).toBe(`changed from ${canonical}`)

    const modifiedCanonical = Math.round(canonical + 1.7)
    expect(yield* ref.get).toBe(modifiedCanonical)
  })


  it.effect.prop(
    "serializes write-through updates and refreshes explicitly",
    [UpdateCountSchema],
    ([updateCount]) => verifiesSerializedUpdates(updateCount),
  )

  it.effect.prop(
    "keeps the cached value unchanged when commit fails",
    [CachedValueSchema],
    ([next]) => verifiesFailedCommit(next),
  )

  it.effect.prop(
    "publishes the canonical value returned by persistence",
    [CachedValueSchema],
    ([next]) => verifiesCanonicalResult(next),
  )
})
