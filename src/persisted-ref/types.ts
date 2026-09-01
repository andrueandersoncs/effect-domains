import { Effect, Function, pipe, SynchronizedRef } from "effect"

const makePersistedRef = <
  A,
  CommitError,
  CommitRequirements,
  LoadError,
  LoadRequirements,
>(
  {
    commit,
    load,
  }: Readonly<{
    commit: (
      previous: A,
      next: A,
    ) => Effect.Effect<A, CommitError, CommitRequirements>
    load: Effect.Effect<A, LoadError, LoadRequirements>
  }>,
) => {
  return Effect.fn("PersistedRef.make")(function* () {
    const initial = yield* load
    const backing = yield* SynchronizedRef.make(initial)
    const get = SynchronizedRef.get(backing)

    const refresh = SynchronizedRef.updateAndGetEffect(
      backing,
      Function.constant(load),
    )

    const commitValue = (value: A) =>
      Effect.fn("PersistedRef.commitValue")(function* (previous: A) {
        return yield* commit(previous, value)
      })

    const commitUpdate = (f: (current: A) => A) =>
      Effect.fn("PersistedRef.commitUpdate")(function* (previous: A) {
        const next = f(previous)

        return yield* commit(previous, next)
      })

    const commitModification = <B>(
      f: (current: A) => readonly [result: B, next: A],
    ) => Effect.fn("PersistedRef.commitModification")(function* (
      previous: A,
    ) {
      const [result, next] = f(previous)
      const persisted = yield* commit(previous, next)

      return [result, persisted] as const
    })

    const set = (value: A) => pipe(
      SynchronizedRef.updateAndGetEffect(backing, commitValue(value)),
      Effect.uninterruptible,
    )

    const update = (f: (current: A) => A) => pipe(
      SynchronizedRef.updateAndGetEffect(backing, commitUpdate(f)),
      Effect.uninterruptible,
    )

    const modify = <B>(
      f: (current: A) => readonly [result: B, next: A],
    ) => pipe(
      SynchronizedRef.modifyEffect(backing, commitModification(f)),
      Effect.uninterruptible,
    )

    return Function.identity({
      get,
      refresh,
      set,
      update,
      modify,
    })
  })()
}

/**
 *
 * Scope: public
 *
 * When to use: One database-backed value must serialize fallible writes because
 * local fibers share its cache.
 *
 * Example:
 * ```ts
 * import { Effect } from "effect"
 * import { PersistedRef } from "effect-domains/persisted-ref/types"
 *
 * const program = PersistedRef.make({ commit: (_previous: number, next: number) => Effect.succeed(next), load: Effect.succeed(0) })
 * ```
 *
 */
export class PersistedRef {
  private constructor() {}

  static make = makePersistedRef
}
