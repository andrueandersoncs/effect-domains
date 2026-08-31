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
import {
  Domain,
  PersistedRef,
  Query,
  Table,
} from "effect-domains"
import * as SqliteBun from "effect-domains/sqlite-bun"

const CounterIdSchema = pipe(
  Schema.String,
  Schema.brand("CounterId"),
  Domain.identifier,
)

const CounterSchema = Schema.Struct({
  id: CounterIdSchema,
  value: Schema.Number,
})

// Counter names the decoded row because PersistedRef shares this value across fibers.
interface Counter extends Schema.Schema.Type<typeof CounterSchema> {}

const Counters = Table.make(CounterSchema, { name: "counters" })
const OptionalCounterSchema = Schema.OptionFromNullOr(CounterSchema)

const CreateCounter = Query.make(Counters, {
  Request: CounterSchema,
  Result: CounterSchema,
  implementation: Effect.fn("CreateCounter.implementation")(function* (
    counter,
  ) {
    const db = yield* SqliteBun.Database
    const insert = db.insert(counter)

    const rows = yield* db<Readonly<Record<string, unknown>>>`
      INSERT INTO ${db(Counters.name)} ${insert}
      RETURNING *
    `

    return pipe(rows, Array.get(0), Option.getOrUndefined)
  }),
})

const FindCounter = Query.make(Counters, {
  Request: CounterIdSchema,
  Result: OptionalCounterSchema,
  implementation: Effect.fn("FindCounter.implementation")(function* (id) {
    const db = yield* SqliteBun.Database

    const rows = yield* db<Readonly<Record<string, unknown>>>`
      SELECT * FROM ${db(Counters.name)}
      WHERE ${db(Counters.identifier)} = ${id}
      LIMIT 1
    `

    return pipe(rows, Array.get(0), Option.getOrNull)
  }),
})

const UpdateCounter = Query.make(Counters, {
  Request: CounterSchema,
  Result: OptionalCounterSchema,
  implementation: Effect.fn("UpdateCounter.implementation")(function* (
    counter,
  ) {
    const db = yield* SqliteBun.Database
    const id = counter[Counters.identifier]
    const changes = db.update(counter, [Counters.identifier])

    const rows = yield* db<Readonly<Record<string, unknown>>>`
      UPDATE ${db(Counters.name)}
      SET ${changes}
      WHERE ${db(Counters.identifier)} = ${id}
      RETURNING *
    `

    return pipe(rows, Array.get(0), Option.getOrNull)
  }),
})

const requireCounter = Effect.fn("Counter.require")(function* (
  effect: Effect.Effect<
    Option.Option<Counter>,
    unknown,
    SqliteBun.Database
  >,
) {
  const counter = yield* effect

  if (Option.isNone(counter)) {
    return yield* Effect.fail("Counter not found" as const)
  }

  return counter.value
})

const commitCounter = Effect.fn("Counter.commit")(function* (
  _previous: Counter,
  next: Counter,
) {
  const update = UpdateCounter.execute(next)

  return yield* requireCounter(update)
})

const incrementedValue = Struct.evolve<
  Counter,
  { readonly value: typeof Number.increment }
>({
  value: Number.increment,
})

const systemTemporaryDirectory = tmpdir()

const temporaryDirectoryPrefix = join(
  systemTemporaryDirectory,
  "effect-domains-persisted-ref-",
)

const acquireTemporaryDirectory = Effect.sync(
  () => mkdtempDisposableSync(temporaryDirectoryPrefix),
)

const makePersistedRefRemove = (
  directory: ReturnType<typeof mkdtempDisposableSync>,
) => Effect.sync(directory.remove)

const temporaryDirectory = Effect.acquireRelease(
  acquireTemporaryDirectory,
  makePersistedRefRemove,
)

const program = Effect.gen(function* () {
  const directory = yield* temporaryDirectory
  const databasePath = join(directory.path, "example.sqlite")
  const databaseOptions = new SqliteBun.SqliteBunOptions(databasePath)
  const DatabaseLive = SqliteBun.layer(databaseOptions)

  const operations = Effect.gen(function* () {
    yield* Counters.createTable()

    const id = CounterIdSchema.make("visits")
    const initial = CounterSchema.make({ id, value: 0 })

    yield* CreateCounter.execute(initial)

    const find = FindCounter.execute(id)
    const load = requireCounter(find)
    const counter = yield* PersistedRef.make(commitCounter)(load)
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

  const result = yield* pipe(operations, Effect.provide(DatabaseLive))

  yield* Effect.log("PersistedRef result", result)
})

await pipe(program, Effect.scoped, Effect.runPromise)
