import { Effect, Equal, Function, Option, pipe, Schema, SynchronizedRef } from "effect"
import { RepositoryStore, ResourceNotFound } from "./repository-store.ts"
import type { Table } from "./table.ts"

type Persistence<A, CE, CR, LE, LR> = Readonly<{
  commit: (previous: A, next: A) => Effect.Effect<A, CE, CR>
  load: Effect.Effect<A, LE, LR>
}>

const makeLoaded = Effect.fn("PersistedRef.makeLoaded")(
    function* <
      A,
      CommitError,
      CommitRequirements,
      LoadError,
      LoadRequirements,
    >(
      initial: A,
      options: Persistence<A, CommitError, CommitRequirements, LoadError, LoadRequirements>,
    ) {
      const backing = yield* SynchronizedRef.make(initial)
      const get = SynchronizedRef.get(backing)

      const refresh = SynchronizedRef.updateAndGetEffect(
        backing,
        Function.constant(options.load),
      )

      const commit = (previous: A, value: A) => options.commit(previous, value)

      const set = (value: A) => pipe(
        SynchronizedRef.updateAndGetEffect(
          backing,
          (previous) => commit(previous, value),
        ),
        Effect.uninterruptible,
      )

      const commitUpdate = (f: (current: A) => A) => (previous: A) => {
        const next = f(previous)

        return options.commit(previous, next)
      }

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
    },
)

const make = Effect.fn("PersistedRef.make")(
  function* <A, CE, CR, LE, LR>(options: Persistence<A, CE, CR, LE, LR>) {
    return yield* makeLoaded(yield* options.load, options)
  },
)

export class PersistedRefKeyError extends Schema.TaggedError<PersistedRefKeyError>()(
  "PersistedRefKeyError",
  { resource: Schema.String },
) {}

const fromResource = Effect.fn("PersistedRef.fromResource")(
  function* <
    Row extends Readonly<Record<string, unknown>>,
    Input extends Readonly<Record<string, unknown>>,
    Key extends keyof Row & string,
    E,
    R,
  >(
    resource: Readonly<{
      name: string
      table: Table & Readonly<{ identifier: Key }>
      repository: Readonly<{
        find: (key: Row[Key]) => Effect.Effect<Option.Option<Row>, E, R>
        create: (input: Input) => Effect.Effect<Row, E, R>
        update: (row: Row) => Effect.Effect<Row, E, R>
      }>
    }>,
    options: Readonly<{
      key: Row[Key]
      ifMissing?: Key extends keyof Input ? Omit<Input, Key> : never
    }>,
  ) {
    const missing = () => ResourceNotFound.make({
      resource: resource.name,
      key: String(options.key),
    })
    const load = Effect.flatMap(resource.repository.find(options.key), Option.match({
      onNone: () => Effect.fail(missing()),
      onSome: Effect.succeed,
    }))
    const store = yield* RepositoryStore
    const initialize = Effect.gen(function* () {
      const existing = yield* resource.repository.find(options.key)
      if (Option.isSome(existing)) {
        return existing.value
      }
      if (options.ifMissing === undefined) {
        return yield* missing()
      }
      const created = yield* resource.repository.create({
        ...options.ifMissing,
        [resource.table.identifier]: options.key,
      } as unknown as Input)
      if (!Equal.equals(created[resource.table.identifier], options.key)) {
        return yield* PersistedRefKeyError.make({ resource: resource.name })
      }
      return created
    })
    const initial = yield* store.transaction(resource.table, initialize)
    const commit = (_previous: Row, next: Row): Effect.Effect<Row, E | PersistedRefKeyError, R> =>
      Equal.equals(next[resource.table.identifier], options.key)
        ? resource.repository.update(next)
        : Effect.fail(PersistedRefKeyError.make({ resource: resource.name }))

    return yield* makeLoaded(initial, { load, commit })
  },
)

export const PersistedRef = { make, fromResource }
