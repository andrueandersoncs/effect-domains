import { mkdtempDisposableSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Array,
  Effect,
  Number,
  Option,
  pipe,
  Schema,
  Struct,
} from "effect"
import { identifier } from "effect-domains/domain"
import { PersistedRef } from "effect-domains/persisted-ref"
import { Query } from "effect-domains/query"
import { Database, SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { Table } from "effect-domains/table"

await pipe(
  Effect.gen(function* () {

    const CounterIdSchema = pipe(
      Schema.String,
      Schema.brand("CounterId"),
      identifier,
    )

    const CounterSchema = Schema.Struct({
      id: CounterIdSchema,
      value: Schema.Number,
    })

    interface Counter extends Schema.Schema.Type<typeof CounterSchema> {}
    const Counters = Table.make({ name: "counters", schema: CounterSchema })
    const OptionalCounterSchema = Schema.OptionFromNullOr(CounterSchema)

    const createCounter = Effect.fn("CreateCounter.implementation")(
      function* (counter: typeof CounterSchema.Encoded) {
        const database = yield* Database
        const insert = database.insert(counter)

        const rows = yield* database<Readonly<Record<string, unknown>>>`
          INSERT INTO ${database(Counters.name)} ${insert}
          RETURNING *
        `

        return pipe(rows, Array.get(0), Option.getOrUndefined)
      },
    )

    const CreateCounter = Query.make({
      table: Counters,
      Request: CounterSchema,
      Result: CounterSchema,
      implementation: createCounter,
    })

    const findCounter = Effect.fn("FindCounter.implementation")(
      function* (id: typeof CounterIdSchema.Encoded) {
        const database = yield* Database

        const rows = yield* database<Readonly<Record<string, unknown>>>`
          SELECT * FROM ${database(Counters.name)}
          WHERE ${database(Counters.identifier)} = ${id}
          LIMIT 1
        `

        return pipe(rows, Array.get(0), Option.getOrNull)
      },
    )

    const FindCounter = Query.make({
      table: Counters,
      Request: CounterIdSchema,
      Result: OptionalCounterSchema,
      implementation: findCounter,
    })

    const updateCounter = Effect.fn("UpdateCounter.implementation")(
      function* (counter: typeof CounterSchema.Encoded) {
        const database = yield* Database
        const id = counter[Counters.identifier]
        const changes = database.update(counter, [Counters.identifier])

        const rows = yield* database<Readonly<Record<string, unknown>>>`
          UPDATE ${database(Counters.name)}
          SET ${changes}
          WHERE ${database(Counters.identifier)} = ${id}
          RETURNING *
        `

        return pipe(rows, Array.get(0), Option.getOrNull)
      },
    )

    const UpdateCounter = Query.make({
      table: Counters,
      Request: CounterSchema,
      Result: OptionalCounterSchema,
      implementation: updateCounter,
    })

    const requireCounter = Effect.fn("Counter.require")(function* (
      effect: Effect.Effect<
        Option.Option<typeof CounterSchema.Type>,
        unknown,
        Database
      >,
    ) {
      const counter = yield* effect

      if (Option.isNone(counter)) {
        return yield* Effect.fail("Counter not found" as const)
      }

      return counter.value
    })

    const commitCounter = Effect.fn("Counter.commit")(function* (
      _previous: typeof CounterSchema.Type,
      next: typeof CounterSchema.Type,
    ) {
      const update = UpdateCounter.execute(next)

      return yield* requireCounter(update)
    })

    const incrementedValue = Struct.evolve<
      typeof CounterSchema.Type,
      { readonly value: typeof Number.increment }
    >({ value: Number.increment })

    const systemTemporaryDirectory = tmpdir()

    const temporaryDirectoryPrefix = join(
      systemTemporaryDirectory,
      "effect-domains-persisted-ref-",
    )

    const acquireTemporaryDirectory = Effect.sync(
      () => mkdtempDisposableSync(temporaryDirectoryPrefix),
    )

    const removeFromMkdtempdisposablesync = (
      directory: ReturnType<typeof mkdtempDisposableSync>,
    ) => Effect.sync(directory.remove)

    const directory = yield* Effect.acquireRelease(
      acquireTemporaryDirectory,
      removeFromMkdtempdisposablesync,
    )

    const databasePath = join(directory.path, "example.sqlite")
    const databaseLayer = SqliteBunRuntime.sqlClient(databasePath)

    const operations = Effect.gen(function* () {
      yield* Counters.write()

      const id = CounterIdSchema.make("visits")
      const initial = CounterSchema.make({ id, value: 0 })

      yield* CreateCounter.execute(initial)

      const find = FindCounter.execute(id)
      const load = requireCounter(find)
      const counter = yield* PersistedRef.make({ commit: commitCounter, load })
      const update = counter.update(incrementedValue)
      const concurrentUpdates = Array.replicate(update, 10)

      yield* Effect.all(concurrentUpdates, { concurrency: "unbounded" })

      const afterWrites = yield* counter.get

      const externallyWritten = CounterSchema.make({
        ...afterWrites,
        value: 100,
      })

      yield* UpdateCounter.execute(externallyWritten)

      const staleBeforeRefresh = yield* counter.get
      const refreshed = yield* counter.refresh

      return { afterWrites, staleBeforeRefresh, refreshed }
    })

    const result = yield* pipe(operations, Effect.provide(databaseLayer))

    yield* Effect.log("PersistedRef result", result)
  }),
  Effect.scoped,
  Effect.runPromise,
)
