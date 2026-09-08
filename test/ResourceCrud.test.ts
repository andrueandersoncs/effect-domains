import { expect, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { identifier } from "../src/domain.ts"
import { Resource } from "../src/resource.ts"
import { SqliteBunRuntime } from "../src/sqlite-bun.ts"
import { SqlClient } from "effect/unstable/sql"
import { prepareTables } from "./prepare-tables.ts"
import { NotesResource } from "../examples/service-codec/resources.ts"
import { StoragePrefix } from "../examples/service-codec/storage.ts"
import { NoteIdSchema } from "../examples/service-codec/domain.ts"

const GeneratedTodos = Resource.make({
  name: "generated_todo_policies",
  schema: Schema.Struct({ title: Schema.NonEmptyString, completed: Schema.Boolean }),
  create: { defaults: { completed: false } },
  operations: [],
})

const PagedTodos = Resource.make({
  name: "paged_todo_policies",
  schema: Schema.Struct({
    id: identifier(Schema.String),
    title: Schema.NonEmptyString,
    completed: Schema.Boolean,
  }),
  list: { filter: ["completed"], order: [{ field: "title" }], limit: 1 },
  operations: [],
})

const sqlite = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })

it.effect("generated CRUD keeps storage codecs off the canonical wire and applies defaults without accepting generated overrides", () =>
  Effect.gen(function* () {
    yield* prepareTables([NotesResource.table, GeneratedTodos.table])

    const note = yield* NotesResource.repository.create({
      id: NoteIdSchema.make("note-1"),
      text: "visible",
    })
    const database = yield* SqlClient.SqlClient
    const rows = yield* database<Readonly<{ readonly text: string }>>`
      SELECT text FROM ${database(NotesResource.table.name)} WHERE id = ${note.id}
    `
    expect(note.text).toBe("visible")
    expect(rows[0]?.text).toBe("stored:visible")

    const todo = yield* GeneratedTodos.repository.create({ title: "defaulted" })
    expect(todo.completed).toBe(false)
    const override = yield* Effect.result(
      GeneratedTodos.repository.create({ title: "bad", id: "caller-id" } as unknown as { readonly title: string }),
    )
    expect(Result.isFailure(override)).toBe(true)
  }).pipe(
    Effect.provideService(StoragePrefix, { value: "stored:" }),
    Effect.provide(sqlite),
  ),
)

it.effect("declared list cursors preserve page boundaries and patch keeps keys immutable and rows valid", () =>
  Effect.gen(function* () {
    yield* prepareTables([PagedTodos.table])
    yield* PagedTodos.repository.create({ id: "1", title: "alpha", completed: false })
    yield* PagedTodos.repository.create({ id: "2", title: "alpha", completed: false })

    const first = yield* PagedTodos.repository.page({ filter: { completed: false }, limit: 1 })
    expect(first.items.map((todo) => todo.id)).toEqual(["1"])
    expect(first.nextCursor).not.toBeNull()
    const second = yield* PagedTodos.repository.page({
      filter: { completed: false },
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    })
    expect(second.items.map((todo) => todo.id)).toEqual(["2"])
    const malformed = yield* Effect.result(PagedTodos.repository.page({
      filter: { completed: false },
      limit: 1,
      cursor: "{}",
    }))
    expect(Result.isFailure(malformed)).toBe(true)

    const immutable = yield* Effect.result(
      PagedTodos.repository.patch("1", { id: "other" } as unknown as { readonly title?: string }),
    )
    expect(Result.isFailure(immutable)).toBe(true)
    const invalid = yield* Effect.result(PagedTodos.repository.patch("1", { title: "" }))
    expect(Result.isFailure(invalid)).toBe(true)
    expect(yield* PagedTodos.repository.get("1")).toMatchObject({ id: "1", title: "alpha" })
  }).pipe(Effect.provide(sqlite)),
)
