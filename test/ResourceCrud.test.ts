import { Authorization, AuthorizationSubject } from "effect-domains/authorization"
import { expect, it } from "@effect/vitest"
import { Array, DateTime, Effect, Option, Ref, Result, Schema, Struct, pipe } from "effect"
import { identifier } from "effect-domains/domain"
import { Resource } from "effect-domains/resource"
import { Application } from "effect-domains/application"
import { ApplicationInspect } from "effect-domains/application-inspect"
import { Value } from "effect-domains/value"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { prepareTables } from "./prepare-tables.ts"
import { FieldReportsResource } from "../examples/field-notes/resources.ts"
import { FieldNoteEncryption, makeFieldNoteEncryption } from "../examples/field-notes/storage.ts"
import { FieldReportIdSchema } from "../examples/field-notes/domain.ts"
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
  yield* prepareTables([FieldReportsResource.table, GeneratedTodos.table])

  const noteInput = FieldReportsResource.schema.make({
    id: FieldReportIdSchema.make("report_crudtest"),
    title: "West site inspection",
    site: "West depot",
    body: "visible\u0000\ud800",
  })

  const note = yield* pipe(FieldReportsResource.repository.create(noteInput), Effect.provideService(AuthorizationSubject, noteAuthor))
  const database = yield* SqlClient.SqlClient

  const rows = yield* database<Readonly<{ readonly body: string }>>`
    SELECT body FROM ${database(FieldReportsResource.table.name)} WHERE id = ${note.id}
  `

  expect(note.body).toBe("visible\u0000\ud800")
  const storedOption = Array.head(rows)
  const stored = Option.getOrThrow(storedOption)
  const encrypted = stored.body !== note.body
  expect(encrypted).toBe(true)
  const loaded = yield* pipe(FieldReportsResource.repository.get(note.id), Effect.provideService(AuthorizationSubject, noteAuthor))
  expect(loaded).toEqual(note)

  const wrongEncryption = makeFieldNoteEncryption("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE")

  const wrongKey = yield* pipe(
    FieldReportsResource.repository.get(note.id),
    Effect.provideService(AuthorizationSubject, noteAuthor),
    Effect.provideServiceEffect(FieldNoteEncryption, wrongEncryption),
    Effect.result,
  )

  expect(wrongKey).toMatchObject({ _tag: "Failure", failure: { _tag: "RepositoryError" } })
  const invalidCiphertext = `${stored.body.slice(0, 20)}AAAAAAAAAAAAAAAAAAAAAA`

  yield* database`
    UPDATE ${database(FieldReportsResource.table.name)} SET body = ${invalidCiphertext} WHERE id = ${note.id}
  `

  const tampered = yield* pipe(
    FieldReportsResource.repository.get(note.id),
    Effect.provideService(AuthorizationSubject, noteAuthor),
    Effect.result,
  )

  expect(tampered).toMatchObject({ _tag: "Failure", failure: { _tag: "RepositoryError" } })
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

const testEncryption = makeFieldNoteEncryption("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
it.effect("generated CRUD protects encrypted text, preserves canonical Unicode, and applies defaults", () => pipe(generatedCrudProgram, Effect.provideServiceEffect(FieldNoteEncryption, testEncryption), Effect.provide(sqlite)))

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

it("compiled creation inspection and input agree on implicit generation and defaults", () => {
  const application = Application.make({ name: "creation-product", parts: [GeneratedTodos] })
  const inspection = ApplicationInspect.describe(application)
  expect(inspection.resources).toMatchObject([{ creation: { defaults: { completed: false }, generated: { id: "uuidV7" }, fromSubject: {} } }])
  const valid = Schema.is(GeneratedTodos.createInputSchema)
  const absentDefault = valid({ title: "draft" })
  const suppliedDefault = valid({ title: "draft", completed: true })
  const suppliedGeneration = valid({ id: "forbidden", title: "draft" })
  expect(absentDefault).toBe(true)
  expect(suppliedDefault).toBe(true)
  expect(suppliedGeneration).toBe(false)
})

it("creation configuration cannot redeclare an implicit identifier", () => {
  expect(() => Resource.make({
    name: "implicit-generation-override",
    schema: GeneratedTodoSchema,
    authorization: Authorization.public,
    operations: { create: { generated: { id: "uuidV7" } } } as never,
  })).toThrow()
})

const GeneratedRecordSchema = Schema.Struct({ id: identifier(Schema.String), at: Schema.DateTimeUtc, summary: Schema.NullOr(Schema.String) })
interface GeneratedRecord extends Schema.Schema.Type<typeof GeneratedRecordSchema> {}

const GeneratedRecords = Resource.make({
  name: "creation_runtime_product",
  schema: GeneratedRecordSchema,
  authorization: Authorization.public,
  operations: { create: { defaults: { summary: null }, generated: { id: "uuidV7", at: "now" } } },
})

it.effect("creation plans evaluate runtime generators per call and default only absent inputs", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([GeneratedRecords.table])
    const counter = yield* Ref.make(0)
    const at = yield* pipe(DateTime.make("2026-09-10T00:00:00.000Z"), Effect.fromOption)

    const values = Value.of({
      uuidV7: Effect.fn("Test.uuidV7")(function* () {
        const value = yield* Ref.updateAndGet(counter, (value) => value + 1)
        return `generated-${value}`
      }),
      now: Effect.fn("Test.now")(function* () { return at }),
    })

    const create = (input: Parameters<typeof GeneratedRecords.repository.create>[0]) =>
      pipe(GeneratedRecords.repository.create(input), Effect.provideService(Value, values))

    const first = yield* create({})
    const second = yield* create({ summary: "authored" })
    expect(first).toEqual({ id: "generated-1", at, summary: null })
    expect(second).toEqual({ id: "generated-2", at, summary: "authored" })
    const override = yield* pipe(create(first), Effect.result)
    const rejected = Result.isFailure(override)
    expect(rejected).toBe(true)
    const calls = yield* Ref.get(counter)
    expect(calls).toBe(2)
  }),
  Effect.provide(sqlite),
))
