import { Effect, Equal, Function, Option, pipe, Record, Schema, SynchronizedRef } from "effect"
import { RepositoryError, RepositoryStore, ResourceNotFound } from "./repository-store.ts"
import type { Table } from "./table.ts"

type Persistence<A, CE, CR, LE, LR> = Readonly<{
  commit: (previous: A, next: A) => Effect.Effect<A, CE, CR>
  load: Effect.Effect<A, LE, LR>
}>


const makeLoaded = Effect.fn("PersistedRef.makeLoaded")(
  function* <A, CommitError, CommitRequirements, LoadError, LoadRequirements>(
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

    const updateTo = (value: A) => SynchronizedRef.updateAndGetEffect(
      backing,
      (previous) => commit(previous, value),
    )

    const set = (value: A) => pipe(updateTo(value), Effect.uninterruptible)

    const commitUpdate = (updateValue: (current: A) => A) => (previous: A) => {
      const next = updateValue(previous)
      return options.commit(previous, next)
    }

    const updateWith = (updateValue: (current: A) => A) =>
      SynchronizedRef.updateAndGetEffect(backing, commitUpdate(updateValue))

    const update = (updateValue: (current: A) => A) =>
      pipe(updateWith(updateValue), Effect.uninterruptible)

    const modifyWith = <B>(
      modifyValue: (current: A) => readonly [result: B, next: A],
    ) => SynchronizedRef.modifyEffect(backing, (previous) => {
      const [result, next] = modifyValue(previous)
      const committed = options.commit(previous, next)
      return Effect.map(committed, (persisted) => [result, persisted] as const)
    })

    const modify = <B>(modifyValue: (current: A) => readonly [result: B, next: A]) =>
      pipe(modifyWith(modifyValue), Effect.uninterruptible)

    return { get, refresh, set, update, modify }
  },
)

const make = Effect.fn("PersistedRef.make")(
  function* <A, CE, CR, LE, LR>(options: Persistence<A, CE, CR, LE, LR>) {
    const initial = yield* options.load
    return yield* makeLoaded(initial, options)
  },
)

export class PersistedRefKeyError extends Schema.TaggedError<PersistedRefKeyError>()(
  "PersistedRefKeyError",
  { resource: Schema.String },
) {}

export const PersistedRef = {
  make,
  fromResource: Effect.fn("PersistedRef.fromResource")(function* <
  Row extends Readonly<Record<string, unknown>>,
  Input extends Readonly<Record<string, unknown>>,
  Key extends keyof Row & string,
  E,
  R,
>(
  resource: Readonly<{
    name: string
    table: Table & Readonly<{
      identifier: Key
      rowSchema: Schema.Schema<Row>
    }>
    createInputSchema: Schema.Schema<Input>
    repository: Readonly<{
      find: (key: Row[Key]) => Effect.Effect<Option.Option<Row>, E, R>
      create: (input: Input) => Effect.Effect<Row, E, R>
      update: (row: Row) => Effect.Effect<Row, E, R>
    }>
  }>,
  options: Readonly<{
    key: Row[Key]
  }> | Readonly<{
    key: Row[Key]
    ifMissing: Key extends keyof Input ? Omit<Input, Key> : never
  }>,
) {
    const missing = ResourceNotFound.make({
      resource: resource.name,
      key: String(options.key),
    })

    const loadQuery = resource.repository.find(options.key)
    const notFound = Effect.fail(missing)

    const load = Effect.flatMap(loadQuery, Option.match({
      onNone: Function.constant(notFound),
      onSome: Effect.succeed,
    }))

    const store = yield* RepositoryStore
    const invalidKey = PersistedRefKeyError.make({ resource: resource.name })
    const keyFailure = Effect.fail(invalidKey)
    const createInputSchema = Schema.toType(resource.createInputSchema)
    const isCreateInput = Schema.is(createInputSchema)
    const invalidInput = RepositoryError.make({ resource: resource.name, cause: invalidKey })

    const initialize = Effect.gen(function* () {
      const existing = yield* resource.repository.find(options.key)
      if (Option.isSome(existing)) return existing.value
      if (!("ifMissing" in options)) return yield* notFound

      const candidate = Record.set(
        options.ifMissing,
        resource.table.identifier,
        options.key,
      )

      if (!isCreateInput(candidate)) return yield* Effect.fail(invalidInput)

      const created = yield* resource.repository.create(candidate)

      return Equal.equals(created[resource.table.identifier], options.key)
        ? created
        : yield* keyFailure
    })

    const initial = yield* store.transaction(resource.table, initialize)

    const commit = (_previous: Row, next: Row): Effect.Effect<Row, E | PersistedRefKeyError, R> =>
      Equal.equals(next[resource.table.identifier], options.key)
        ? resource.repository.update(next)
        : keyFailure

    return yield* makeLoaded(initial, { load, commit })
  }),
}
