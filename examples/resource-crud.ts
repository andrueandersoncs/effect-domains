import { BunFileSystem } from "@effect/platform-bun"
import { join } from "node:path"
import { Effect, FileSystem, Option, pipe, Schema } from "effect"
import { Resource } from "effect-domains/resource"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"

const TodoSchema = Schema.Struct({
  title: Schema.NonEmptyString,
  completed: Schema.Boolean,
})

interface Todo extends Schema.Schema.Type<typeof TodoSchema> {}

const Todos = Resource.make({
  name: "todos",
  schema: TodoSchema,
  operations: ["get", "list", "create", "update", "remove"],
})

await pipe(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const directory = yield* fs.makeTempDirectoryScoped({
      prefix: "effect-domains-resource-crud-",
    })

    const databasePath = join(directory, "example.sqlite")
    const runtime = SqliteBunRuntime.sqlClient(databasePath, { migrations: [] })

    const operations = Effect.gen(function* () {
      yield* Todos.table.write()

      const todo: Todo = TodoSchema.make({
        title: "Ship more examples",
        completed: false,
      })

      const created = yield* Todos.repository.create(todo)
      const found = yield* Todos.repository.get(created.id)

      const completed = yield* Todos.repository.update({
        ...found,
        completed: true,
      })

      const listed = yield* Todos.repository.list()
      yield* Todos.repository.remove(completed.id)
      const afterRemoval = yield* Todos.repository.find(completed.id)

      return {
        created,
        completed,
        listed,
        existsAfterRemoval: Option.isSome(afterRemoval),
      }
    })

    const result = yield* pipe(operations, Effect.provide(runtime))

    yield* Effect.log("Resource CRUD result", result)
  }),
  Effect.scoped,
  Effect.provide(BunFileSystem.layer),
  Effect.runPromise,
)
