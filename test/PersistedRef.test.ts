import assert from "node:assert/strict"
import { describe, test } from "bun:test"
import {
  Array,
  Effect,
  Function,
  pipe,
  Ref,
} from "effect"
import { PersistedRef } from "../index.ts"

const increment = (current: number) => current + 1

const describeChange = (current: number) =>
  [`changed from ${current}`, current + 1.7] as const

const verifiesSerializedUpdates = Effect.gen(function* () {
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

  const ref = yield* PersistedRef.make(commit)(load)
  const update = ref.update(increment)
  const updates = Array.makeBy(20, Function.constant(update))

  yield* Effect.all(updates, { concurrency: "unbounded" })

  const cached = yield* ref.get
  const stored = yield* Ref.get(durable)

  assert.equal(cached, 20)
  assert.equal(stored, 20)

  yield* Ref.set(durable, 41)

  const stale = yield* ref.get
  const refreshed = yield* ref.refresh

  assert.equal(stale, 20)
  assert.equal(refreshed, 41)
  assert.equal(yield* ref.get, 41)
})

const failedLoad = Effect.succeed(1)

const failCommit = Effect.fn("PersistedRefTest.failCommit")(function* (
  _previous: number,
  _next: number,
) {
  return yield* Effect.fail("commit failed" as const)
})

const verifiesFailedCommit = Effect.gen(function* () {
  const ref = yield* PersistedRef.make(failCommit)(failedLoad)

  const committed = yield* pipe(
    ref.set(2),
    Effect.match({
      onFailure: Function.constant(false),
      onSuccess: Function.constant(true),
    }),
  )

  assert.equal(committed, false)
  assert.equal(yield* ref.get, 1)
})

const canonicalLoad = Effect.succeed(0)

const roundCommit = Effect.fn("PersistedRefTest.roundCommit")(function* (
  _previous: number,
  next: number,
) {
  const rounded = Math.round(next)

  return yield* Effect.succeed(rounded)
})

const verifiesCanonicalResult = Effect.gen(function* () {
  const ref = yield* PersistedRef.make(roundCommit)(canonicalLoad)

  yield* ref.set(1.6)

  assert.equal(yield* ref.get, 2)

  const result = yield* ref.modify(describeChange)

  assert.equal(result, "changed from 2")
  assert.equal(yield* ref.get, 4)
})

describe("PersistedRef", () => {
  test("serializes write-through updates and refreshes explicitly", () =>
    pipe(verifiesSerializedUpdates, Effect.runPromise))

  test("keeps the cached value unchanged when commit fails", () =>
    pipe(verifiesFailedCommit, Effect.runPromise))

  test("publishes the canonical value returned by persistence", () =>
    pipe(verifiesCanonicalResult, Effect.runPromise))
})
