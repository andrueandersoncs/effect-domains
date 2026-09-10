import { Authorization, AuthorizationSubject } from "effect-domains/authorization"
import { expect, it } from "@effect/vitest"
import { Array, DateTime, Effect, Option, Result, Schema, Struct, pipe } from "effect"
import { identifier } from "effect-domains/domain"
import { Resource } from "effect-domains/resource"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { prepareTables } from "./prepare-tables.ts"
import { NotesResource } from "../apps/service-codec/resources.ts"
import { StoragePrefix } from "../apps/service-codec/storage.ts"
import { NoteIdSchema } from "../apps/service-codec/domain.ts"
import { ExampleSubjectSchema } from "@effect-domains/example-support/authentication"
import { RpcTest } from "effect/unstable/rpc"

const GeneratedTodoSchema = Schema.Struct({ title: Schema.NonEmptyString, completed: Schema.Boolean })
interface GeneratedTodo extends Schema.Schema.Type<typeof GeneratedTodoSchema> {}
const GeneratedTodos = Resource.make({ authorization: Authorization.public, name: "generated_todo_policies", schema: GeneratedTodoSchema, operations: { create: { defaults: { completed: false }, publish: false } } })

const PagedTodoSchema = Schema.Struct({
  id: identifier(Schema.String),
  title: Schema.NonEmptyString,
  completed: Schema.Boolean,
})

interface PagedTodo extends Schema.Schema.Type<typeof PagedTodoSchema> {}
const PagedTodos = Resource.make({ authorization: Authorization.public, name: "paged_todo_policies", schema: PagedTodoSchema, operations: { list: { filter: ["completed"], limit: 1, publish: false } } })

const DefaultTodoSchema = Schema.Struct({ id: identifier(Schema.Int), title: Schema.NonEmptyString })
interface DefaultTodo extends Schema.Schema.Type<typeof DefaultTodoSchema> {}

const DefaultTodos = Resource.make({
  authorization: Authorization.public,
  name: "default_todos",
  schema: DefaultTodoSchema,
  operations: { ...Resource.crud, patch: true },
})

it.effect("default generated lists return bounded identifier-ordered pages through repository and RPC", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([DefaultTodos.table])
    const client = yield* RpcTest.makeClient(DefaultTodos.group)
    const empty = yield* client["default_todos.list"]({})
    expect(empty).toEqual({ items: [], nextCursor: null })
    yield* pipe(Array.range(1, 51), Effect.forEach((id) => DefaultTodos.repository.create({ id, title: "todo" })))
    const first = yield* DefaultTodos.repository.list()
    const identifiers = Array.map(first.items, Struct.get("id"))
    const expectedIdentifiers = Array.range(1, 50)
    expect(identifiers).toEqual(expectedIdentifiers)
    const rpcFirst = yield* client["default_todos.list"]({})
    expect(rpcFirst).toEqual(first)
    const cursor = yield* Effect.fromNullishOr(first.nextCursor)
    const last = yield* client["default_todos.list"]({ cursor })
    expect(last).toEqual({ items: [{ id: 51, title: "todo" }], nextCursor: null })
    const zeroLimit = yield* pipe(DefaultTodos.repository.list({ limit: 0 }), Effect.result)
    const excessiveLimit = yield* pipe(DefaultTodos.repository.list({ limit: 51 }), Effect.result)
    const zeroFailed = Result.isFailure(zeroLimit)
    const excessiveFailed = Result.isFailure(excessiveLimit)
    expect(zeroFailed).toBe(true)
    expect(excessiveFailed).toBe(true)
  }),
  Effect.provide(DefaultTodos.handlers),
  Effect.provide(sqlite),
  Effect.scoped,
))

it.effect("generated CRUD retains all six operations with a uniform list page", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([DefaultTodos.table])
    const client = yield* RpcTest.makeClient(DefaultTodos.group)
    const created = yield* client["default_todos.create"]({ id: 1, title: "created" })
    const found = yield* client["default_todos.get"]({ id: created.id })
    expect(found).toEqual(created)
    const updated = yield* client["default_todos.update"]({ ...created, title: "updated" })
    expect(updated.title).toBe("updated")
    const patched = yield* client["default_todos.patch"]({ key: created.id, changes: { title: "patched" } })
    const listed = yield* client["default_todos.list"]({})
    expect(listed).toEqual({ items: [patched], nextCursor: null })
    yield* client["default_todos.remove"]({ id: created.id })
    const empty = yield* client["default_todos.list"]({})
    expect(empty).toEqual({ items: [], nextCursor: null })
  }),
  Effect.provide(DefaultTodos.handlers),
  Effect.provide(sqlite),
  Effect.scoped,
))

const OrderedTodoFieldsSchema = Schema.Struct({
  lower: Schema.Int,
  upper: Schema.Int,
})

interface OrderedTodoFields extends Schema.Schema.Type<typeof OrderedTodoFieldsSchema> {}

const OrderedTodoSchema = OrderedTodoFieldsSchema.check(
  Schema.makeFilter((value: OrderedTodoFields) => value.lower < value.upper),
)

const OrderedTodos = Resource.make({
  authorization: Authorization.public,
  name: "ordered_todo_policies",
  schema: OrderedTodoSchema,
  operations: {},
})

const sqlite = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })
const todoIdentifier = Struct.get<PagedTodo, "id">("id")
const noteAuthor = ExampleSubjectSchema.make({ userId: "codec-author", tenantId: "codec-test", roles: ["editor"] })

const generatedCrudProgram = Effect.gen(function* () {
  yield* prepareTables([NotesResource.table, GeneratedTodos.table])

  const noteInput = NotesResource.schema.make({
    id: NoteIdSchema.make("note-1"),
    text: "visible",
  })

  const note = yield* pipe(NotesResource.repository.create(noteInput), Effect.provideService(AuthorizationSubject, noteAuthor))
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
  yield* PagedTodos.repository.create({ id: "2", title: "aardvark", completed: false })
  yield* PagedTodos.repository.create({ id: "1", title: "alpha", completed: false })
  yield* PagedTodos.repository.create({ id: "1.5", title: "hidden", completed: true })

  const first = yield* PagedTodos.repository.list({ filter: { completed: false }, limit: 1 })
  const firstIdentifiers = Array.map(first.items, todoIdentifier)
  expect(firstIdentifiers).toEqual(["1"])
  const firstCursor = Option.fromNullishOr(first.nextCursor)
  const hasFirstCursor = Option.isSome(firstCursor)
  expect(hasFirstCursor).toBe(true)

  const second = yield* PagedTodos.repository.list({
    filter: { completed: false },
    limit: 1,
    cursor: first.nextCursor ?? undefined,
  })

  const secondIdentifiers = Array.map(second.items, todoIdentifier)
  expect(secondIdentifiers).toEqual(["2"])
  expect(second.nextCursor).toBeNull()

  const malformedPage = PagedTodos.repository.list({
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

it.effect("identifier cursors preserve filtered page boundaries and patch keeps keys immutable and rows valid", () => pipe(pagedCrudProgram, Effect.provide(sqlite)))

const orderedCrudProgram = Effect.gen(function* () {
  yield* prepareTables([OrderedTodos.table])
  const database = yield* SqlClient.SqlClient
  const invalidCreateEffect = OrderedTodos.repository.create({ lower: 4, upper: 1 })
  const invalidCreate = yield* Effect.result(invalidCreateEffect)
  const invalidCreateFailed = Result.isFailure(invalidCreate)
  expect(invalidCreateFailed).toBe(true)

  const created = yield* OrderedTodos.repository.create({ lower: 1, upper: 4 })
  const invalidUpdateEffect = OrderedTodos.repository.update({ ...created, lower: 4, upper: 1 })
  const invalidUpdate = yield* Effect.result(invalidUpdateEffect)
  const invalidPatchEffect = OrderedTodos.repository.patch(created.id, { lower: 4 })
  const invalidPatch = yield* Effect.result(invalidPatchEffect)
  const invalidUpdateFailed = Result.isFailure(invalidUpdate)
  const invalidPatchFailed = Result.isFailure(invalidPatch)

  expect(invalidUpdateFailed).toBe(true)
  expect(invalidPatchFailed).toBe(true)

  const rows = yield* database<Readonly<{ readonly lower: number; readonly upper: number }>>`
    SELECT lower, upper FROM ${database(OrderedTodos.table.name)}
  `

  expect(rows).toEqual([{ lower: 1, upper: 4 }])
})

it.effect(
  "implicit identifiers preserve canonical checks for SQLite create, update, and patch",
  () => pipe(orderedCrudProgram, Effect.provide(sqlite)),
)

const TimestampSchema = Schema.Struct({ id: identifier(Schema.String), at: Schema.DateTimeUtc })
interface Timestamp extends Schema.Schema.Type<typeof TimestampSchema> {}

const Timestamps = Resource.make({
  name: "timestamp_query_codec",
  schema: TimestampSchema,
  authorization: Authorization.public,
  operations: { list: { filter: ["at"], limit: 1, publish: false } },
})

it.effect("timestamp filters use the physical codec across cursor pages", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([Timestamps.table])
    const at = yield* pipe(DateTime.make("2026-09-09T00:00:00.000Z"), Effect.fromOption)
    const different = yield* pipe(DateTime.make("2026-09-10T00:00:00.000Z"), Effect.fromOption)
    yield* Timestamps.repository.create({ id: "a", at })
    yield* Timestamps.repository.create({ id: "b", at: different })
    yield* Timestamps.repository.create({ id: "c", at })
    const first = yield* Timestamps.repository.list({ filter: { at } })
    const firstIds = Array.map(first.items, Struct.get("id"))
    expect(firstIds).toEqual(["a"])
    const cursor = yield* pipe(Option.fromNullishOr(first.nextCursor), Effect.fromOption)
    const second = yield* Timestamps.repository.list({ filter: { at }, cursor })
    const secondIds = Array.map(second.items, Struct.get("id"))
    expect(secondIds).toEqual(["c"])
    expect(second.nextCursor).toBeNull()
  }),
  Effect.provide(sqlite),
))

const EncodedNumberSchema = Schema.Struct({ id: identifier(Schema.NumberFromString), quantity: Schema.Number })
interface EncodedNumber extends Schema.Schema.Type<typeof EncodedNumberSchema> {}

it("rejects generated list for an identifier with a semantic order-breaking codec", () => {
  expect(() => Resource.make({
    name: "semantic_numeric_order",
    schema: EncodedNumberSchema,
    authorization: Authorization.public,
    operations: { list: true },
  })).toThrow()
})

const PatchNamedKeySchema = Schema.Struct({
  patch: identifier(Schema.String),
  key: Schema.String,
  changes: Schema.String,
})

interface PatchNamedKey extends Schema.Schema.Type<typeof PatchNamedKeySchema> {}

const PatchNamedKeys = Resource.make({
  name: "patch_named_keys",
  schema: PatchNamedKeySchema,
  authorization: Authorization.public,
  operations: { patch: true },
})

it.effect("generated patch envelopes cannot collide with canonical field names", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([PatchNamedKeys.table])
    yield* PatchNamedKeys.repository.create({ patch: "row", key: "before-key", changes: "before-changes" })

    const procedure = yield* pipe(
      PatchNamedKeys.group.requests.get("patch_named_keys.patch"),
      Option.fromUndefinedOr,
      Effect.fromOption,
    )

    const decoded = yield* Schema.decodeUnknownEffect(procedure.payloadSchema)({
      key: "row",
      changes: { key: "after-key", changes: "after-changes" },
    })

    const client = yield* RpcTest.makeClient(PatchNamedKeys.group)
    yield* client["patch_named_keys.patch"](decoded)
    const stored = yield* PatchNamedKeys.repository.get("row")
    expect(stored).toEqual({ patch: "row", key: "after-key", changes: "after-changes" })
  }),
  Effect.provide(PatchNamedKeys.handlers),
  Effect.provide(sqlite),
  Effect.scoped,
))
