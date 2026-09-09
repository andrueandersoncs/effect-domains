import { Authorization } from "../src/authorization.ts"
import { expect, it } from "@effect/vitest"
import { Array, Effect, Option, Result, Schema, Struct, pipe } from "effect"
import { identifier } from "../src/domain.ts"
import { Resource } from "../src/resource.ts"
import { SqliteBunRuntime } from "../src/sqlite-bun.ts"
import { SqlClient } from "effect/unstable/sql"
import { prepareTables } from "./prepare-tables.ts"
import { NotesResource } from "../examples/service-codec/resources.ts"
import { StoragePrefix } from "../examples/service-codec/storage.ts"
import { NoteIdSchema } from "../examples/service-codec/domain.ts"

const GeneratedTodoSchema = Schema.Struct({ title: Schema.NonEmptyString, completed: Schema.Boolean })
interface GeneratedTodo extends Schema.Schema.Type<typeof GeneratedTodoSchema> {}
const GeneratedTodos = Resource.make({ authorization: Authorization.public, name: "generated_todo_policies", schema: GeneratedTodoSchema, create: { defaults: { completed: false } }, operations: [] })

const PagedTodoSchema = Schema.Struct({
  id: identifier(Schema.String),
  title: Schema.NonEmptyString,
  completed: Schema.Boolean,
})

interface PagedTodo extends Schema.Schema.Type<typeof PagedTodoSchema> {}
const PagedTodos = Resource.make({ authorization: Authorization.public, name: "paged_todo_policies", schema: PagedTodoSchema, list: { filter: ["completed"], order: [{ field: "title" }], limit: 1 }, operations: [] })
const sqlite = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })
const todoIdentifier = Struct.get<PagedTodo, "id">("id")

const generatedCrudProgram = Effect.gen(function* () {
  yield* prepareTables([NotesResource.table, GeneratedTodos.table])

  const noteInput = NotesResource.schema.make({
    id: NoteIdSchema.make("note-1"),
    text: "visible",
  })

  const note = yield* NotesResource.repository.create(noteInput)
  const database = yield* SqlClient.SqlClient

  const rows = yield* database<Readonly<{ readonly text: string }>>`
    SELECT text FROM ${database(NotesResource.table.name)} WHERE id = ${note.id}
  `

  expect(note.text).toBe("visible")
  expect(rows).toEqual([{ text: "stored:visible" }])
  const todo = yield* GeneratedTodos.repository.create({ title: "defaulted" })
  expect(todo.completed).toBe(false)

  const override = GeneratedTodos.table.rowSchema.make({
    id: todo.id,
    title: "bad",
    completed: false,
  })

  const overrideCreation = GeneratedTodos.repository.create(override)
  const rejectedOverride = yield* Effect.result(overrideCreation)
  const overrideFailed = Result.isFailure(rejectedOverride)
  expect(overrideFailed).toBe(true)
})

it.effect("generated CRUD keeps storage codecs off the canonical wire and applies defaults", () => pipe(generatedCrudProgram, Effect.provideService(StoragePrefix, { value: "stored:" }), Effect.provide(sqlite)))

const pagedCrudProgram = Effect.gen(function* () {
  yield* prepareTables([PagedTodos.table])
  yield* PagedTodos.repository.create({ id: "1", title: "alpha", completed: false })
  yield* PagedTodos.repository.create({ id: "2", title: "alpha", completed: false })

  const first = yield* PagedTodos.repository.page({ filter: { completed: false }, limit: 1 })
  const firstIdentifiers = Array.map(first.items, todoIdentifier)
  expect(firstIdentifiers).toEqual(["1"])
  const firstCursor = Option.fromNullishOr(first.nextCursor)
  const hasFirstCursor = Option.isSome(firstCursor)
  expect(hasFirstCursor).toBe(true)

  const second = yield* PagedTodos.repository.page({
    filter: { completed: false },
    limit: 1,
    cursor: first.nextCursor ?? undefined,
  })

  const secondIdentifiers = Array.map(second.items, todoIdentifier)
  expect(secondIdentifiers).toEqual(["2"])

  const malformedPage = PagedTodos.repository.page({
    filter: { completed: false },
    limit: 1,
    cursor: "{}",
  })

  const malformed = yield* Effect.result(malformedPage)
  const malformedFailed = Result.isFailure(malformed)
  expect(malformedFailed).toBe(true)

  const redirectedPatchInput = PagedTodoSchema.make({
    title: "alpha",
    id: "other",
    completed: false,
  })

  const redirectedPatch = PagedTodos.repository.patch("1", redirectedPatchInput)
  const immutable = yield* Effect.result(redirectedPatch)
  const immutableFailed = Result.isFailure(immutable)
  expect(immutableFailed).toBe(true)

  const invalidPatch = PagedTodos.repository.patch("1", { title: "" })
  const invalid = yield* Effect.result(invalidPatch)
  const invalidFailed = Result.isFailure(invalid)
  expect(invalidFailed).toBe(true)

  const todo = yield* PagedTodos.repository.get("1")
  expect(todo).toMatchObject({ id: "1", title: "alpha" })
})

it.effect("declared list cursors preserve page boundaries and patch keeps keys immutable and rows valid", () => pipe(pagedCrudProgram, Effect.provide(sqlite)))
