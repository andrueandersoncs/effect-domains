import { Effect, Function, pipe, SynchronizedRef } from "effect"

export const PersistedRef = {
  make: <
    A,
    CommitError,
    CommitRequirements,
    LoadError,
    LoadRequirements,
  >(
    options: Readonly<{
      commit: (
        previous: A,
        next: A,
      ) => Effect.Effect<A, CommitError, CommitRequirements>
      load: Effect.Effect<A, LoadError, LoadRequirements>
    }>,
  ) =>
    Effect.fn("PersistedRef.make")(function* () {
      const initial = yield* options.load
      const backing = yield* SynchronizedRef.make(initial)
      const get = SynchronizedRef.get(backing)

      const refresh = SynchronizedRef.updateAndGetEffect(
        backing,
        Function.constant(options.load),
      )

      const set = (value: A) => pipe(
        SynchronizedRef.updateAndGetEffect(
          backing,
          (previous) => options.commit(previous, value),
        ),
        Effect.uninterruptible,
      )

      const commitUpdate = (f: (current: A) => A) => (previous: A) =>
        options.commit(previous, f(previous))

      const update = (f: (current: A) => A) => pipe(
        SynchronizedRef.updateAndGetEffect(backing, commitUpdate(f)),
        Effect.uninterruptible,
      )

      const modify = <B>(
        f: (current: A) => readonly [result: B, next: A],
      ) => pipe(
        SynchronizedRef.modifyEffect(backing, (previous) => {
          const [result, next] = f(previous)

          return pipe(
            options.commit(previous, next),
            Effect.map((persisted) => [result, persisted] as const),
          )
        }),
        Effect.uninterruptible,
      )

      return { get, refresh, set, update, modify }
    })(),
}
