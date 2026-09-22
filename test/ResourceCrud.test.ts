import { Authorization, AuthorizationSubject } from "effect-domains/authorization"
import { expect, it } from "@effect/vitest"
import { Array, Data, DateTime, Effect, Option, Ref, Result, Schema, Struct, pipe } from "effect"
import { identifier } from "effect-domains/domain"
import { Resource } from "effect-domains/resource"
import { Transitions } from "effect-domains/transitions"
import { Application, Part } from "effect-domains/application"
import { ApplicationInspect } from "effect-domains/application-inspect"
import { Value } from "effect-domains/value"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { prepareTables } from "./prepare-tables.ts"
import { FieldReportsResource } from "@effect-domains/example-field-notes/resources"
import { fieldNoteEncryptionLayer } from "@effect-domains/example-field-notes/storage"
import { FieldReportIdSchema } from "@effect-domains/example-field-notes/domain"
import { ExampleSubjectSchema } from "@effect-domains/example-support/subject"
import { RpcTest } from "effect/unstable/rpc"

const fieldReportsTable = Resource.table(FieldReportsResource)

const GeneratedTodoSchema = Schema.Struct({ title: Schema.NonEmptyString, completed: Schema.Boolean })

interface GeneratedTodo extends Schema.Schema.Type<typeof GeneratedTodoSchema> {}

const completedDefault = Resource.default(false)
const generatedTodoSources = Object.freeze({ completed: completedDefault })

const generatedTodoCapabilities = [Resource.create({
  sources: generatedTodoSources,
  publish: false,
})]

const GeneratedTodos = Resource.define({
  authorization: Authorization.public,
  name: "generated_todo_policies",
  schema: GeneratedTodoSchema,
  capabilities: generatedTodoCapabilities,
})

const generatedTodosTable = Resource.table(GeneratedTodos)
const GeneratedTodosRuntime = Resource.compile(GeneratedTodos)

const PagedTodoSchema = Schema.Struct({
  id: identifier(Schema.String),
  title: Schema.NonEmptyString,
  completed: Schema.Boolean,
})

interface PagedTodo extends Schema.Schema.Type<typeof PagedTodoSchema> {}

const pagedTodoCapabilities = [Resource.list({
  filter: ["completed"],
  limit: 1,
  publish: false,
})]

const PagedTodos = Resource.define({
  authorization: Authorization.public,
  name: "paged_todo_policies",
  schema: PagedTodoSchema,
  capabilities: pagedTodoCapabilities,
})

const pagedTodosTable = Resource.table(PagedTodos)

const ascendingCursorCapabilities = [Resource.list({
  limit: 1,
  order: [["title", "asc"]],
  publish: false,
})]

const CursorAscendingTodos = Resource.define({
  authorization: Authorization.public,
  name: "cursor_contract_todos",
  schema: PagedTodoSchema,
  capabilities: ascendingCursorCapabilities,
})

const cursorAscendingTodosTable = Resource.table(CursorAscendingTodos)

const descendingCursorCapabilities = [Resource.list({
  limit: 1,
  order: [["title", "desc"]],
  publish: false,
})]

const CursorDescendingTodos = Resource.define({
  authorization: Authorization.public,
  name: "cursor_contract_todos",
  schema: PagedTodoSchema,
  capabilities: descendingCursorCapabilities,
})

const DefaultTodoSchema = Schema.Struct({ id: identifier(Schema.Int), title: Schema.NonEmptyString })

interface DefaultTodo extends Schema.Schema.Type<typeof DefaultTodoSchema> {}

const defaultTodoCapabilities = [...Resource.crud(), Resource.patch()]

const DefaultTodos = Resource.define({
  authorization: Authorization.public,
  name: "default_todos",
  schema: DefaultTodoSchema,
  capabilities: defaultTodoCapabilities,
})

const defaultTodosTable = Resource.table(DefaultTodos)
const DefaultTodosRuntime = Resource.compile(DefaultTodos)

it.effect("default generated lists return bounded identifier-ordered pages through repository and RPC", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([defaultTodosTable])

    const client = yield* RpcTest.makeClient(DefaultTodosRuntime.group)
    const empty = yield* client["default_todos.list"]({})

    expect(empty).toEqual({ items: [], nextCursor: null })
    yield* pipe(Array.range(1, 51), Effect.forEach((id) => Resource.repository(DefaultTodos).create({ id, title: "todo" })))

    const first = yield* Resource.repository(DefaultTodos).list()
    const identifiers = Array.map(first.items, Struct.get("id"))
    const expectedIdentifiers = Array.range(1, 50)

    expect(identifiers).toEqual(expectedIdentifiers)

    const rpcFirst = yield* client["default_todos.list"]({})

    expect(rpcFirst).toEqual(first)

    const cursor = yield* Effect.fromNullishOr(first.nextCursor)
    const last = yield* client["default_todos.list"]({ cursor })

    expect(last).toEqual({ items: [{ id: 51, title: "todo" }], nextCursor: null })

    const zeroLimit = yield* pipe(Resource.repository(DefaultTodos).list({ limit: 0 }), Effect.result)
    const excessiveLimit = yield* pipe(Resource.repository(DefaultTodos).list({ limit: 51 }), Effect.result)
    const zeroFailed = Result.isFailure(zeroLimit)
    const excessiveFailed = Result.isFailure(excessiveLimit)

    expect(zeroFailed).toBe(true)
    expect(excessiveFailed).toBe(true)
  }),
  Effect.provide(DefaultTodosRuntime.handlers),
  Effect.provide(sqlite),
  Effect.scoped,
))

it.effect("generated CRUD retains all six operations with a uniform list page", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([defaultTodosTable])

    const client = yield* RpcTest.makeClient(DefaultTodosRuntime.group)
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
  Effect.provide(DefaultTodosRuntime.handlers),
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

const OrderedTodos = Resource.define({
  authorization: Authorization.public,
  name: "ordered_todo_policies",
  schema: OrderedTodoSchema,
  capabilities: [],
})

const orderedTodosTable = Resource.table(OrderedTodos)

const sqlite = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })
const todoIdentifier = Struct.get<PagedTodo, "id">("id")
const noteAuthor = ExampleSubjectSchema.make({ userId: "codec-author", tenantId: "codec-test", roles: ["editor"] })

const generatedCrudProgram = Effect.gen(function* () {
  yield* prepareTables([fieldReportsTable, generatedTodosTable])

  const noteInput = FieldReportsResource.schema.make({
    id: FieldReportIdSchema.make("report_crudtest"),
    title: "West site inspection",
    site: "West depot",
    body: "visible\u0000\ud800",
  })

  const note = yield* pipe(Resource.repository(FieldReportsResource).create(noteInput), Effect.provideService(AuthorizationSubject, noteAuthor))
  const database = yield* SqlClient.SqlClient

  const rows = yield* database<Readonly<{ readonly body: string }>>`
    SELECT body FROM ${database(fieldReportsTable.name)} WHERE id = ${note.id}
  `

  expect(note.body).toBe("visible\u0000\ud800")

  const storedOption = Array.head(rows)
  const stored = Option.getOrThrow(storedOption)
  const encrypted = stored.body !== note.body

  expect(encrypted).toBe(true)

  const loaded = yield* pipe(Resource.repository(FieldReportsResource).get(note.id), Effect.provideService(AuthorizationSubject, noteAuthor))

  expect(loaded).toEqual(note)

  const wrongEncryption = fieldNoteEncryptionLayer("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE")

  const wrongKey = yield* pipe(
    Resource.repository(FieldReportsResource).get(note.id),
    Effect.provideService(AuthorizationSubject, noteAuthor),
    Effect.provide(wrongEncryption),
    Effect.result,
  )

  expect(wrongKey).toMatchObject({ _tag: "Failure", failure: { _tag: "RepositoryError" } })

  const invalidCiphertext = `${stored.body.slice(0, 20)}AAAAAAAAAAAAAAAAAAAAAA`

  yield* database`
    UPDATE ${database(fieldReportsTable.name)} SET body = ${invalidCiphertext} WHERE id = ${note.id}
  `

  const tampered = yield* pipe(
    Resource.repository(FieldReportsResource).get(note.id),
    Effect.provideService(AuthorizationSubject, noteAuthor),
    Effect.result,
  )

  expect(tampered).toMatchObject({ _tag: "Failure", failure: { _tag: "RepositoryError" } })

  const todo = yield* Resource.repository(GeneratedTodos).create({ title: "defaulted" })

  expect(todo.completed).toBe(false)

  const override = generatedTodosTable.rowSchema.make({
    id: todo.id,
    title: "bad",
    completed: false,
  })

  const overrideCreation = Resource.repository(GeneratedTodos).create(override)
  const rejectedOverride = yield* Effect.result(overrideCreation)
  const overrideFailed = Result.isFailure(rejectedOverride)

  expect(overrideFailed).toBe(true)
})

const testEncryption = fieldNoteEncryptionLayer("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")

it.effect("generated CRUD protects encrypted text, preserves canonical Unicode, and applies defaults", () => pipe(generatedCrudProgram, Effect.provide(testEncryption), Effect.provide(sqlite)))

const pagedCrudProgram = Effect.gen(function* () {
  yield* prepareTables([pagedTodosTable])
  yield* Resource.repository(PagedTodos).create({ id: "2", title: "aardvark", completed: false })
  yield* Resource.repository(PagedTodos).create({ id: "1", title: "alpha", completed: false })
  yield* Resource.repository(PagedTodos).create({ id: "1.5", title: "hidden", completed: true })

  const first = yield* Resource.repository(PagedTodos).list({ filter: { completed: false }, limit: 1 })
  const firstIdentifiers = Array.map(first.items, todoIdentifier)

  expect(firstIdentifiers).toEqual(["1"])

  const firstCursor = Option.fromNullishOr(first.nextCursor)
  const hasFirstCursor = Option.isSome(firstCursor)

  expect(hasFirstCursor).toBe(true)

  const second = yield* Resource.repository(PagedTodos).list({
    filter: { completed: false },
    limit: 1,
    cursor: first.nextCursor ?? undefined,
  })

  const secondIdentifiers = Array.map(second.items, todoIdentifier)

  expect(secondIdentifiers).toEqual(["2"])
  expect(second.nextCursor).toBeNull()

  const malformedPage = Resource.repository(PagedTodos).list({
    filter: { completed: false },
    limit: 1,
    cursor: "{}",
  })

  const malformed = yield* Effect.result(malformedPage)
  const malformedFailed = Result.isFailure(malformed)

  expect(malformedFailed).toBe(true)

  const missingAfterCursor = JSON.stringify({ after: {} })
  const missingAfterPage = Resource.repository(PagedTodos).list({ filter: { completed: false }, limit: 1, cursor: missingAfterCursor })
  const missingAfter = yield* Effect.result(missingAfterPage)
  const wrongAfterCursor = JSON.stringify({ after: { id: 1 } })
  const wrongAfterPage = Resource.repository(PagedTodos).list({ filter: { completed: false }, limit: 1, cursor: wrongAfterCursor })
  const wrongAfterType = yield* Effect.result(wrongAfterPage)
  const missingAfterFailed = Result.isFailure(missingAfter)
  const wrongAfterTypeFailed = Result.isFailure(wrongAfterType)

  expect(missingAfterFailed).toBe(true)
  expect(wrongAfterTypeFailed).toBe(true)

  const redirectedPatchInput = PagedTodoSchema.make({
    title: "alpha",
    id: "other",
    completed: false,
  })

  const redirectedPatch = Resource.repository(PagedTodos).patch("1", redirectedPatchInput)
  const immutable = yield* Effect.result(redirectedPatch)
  const immutableFailed = Result.isFailure(immutable)

  expect(immutableFailed).toBe(true)

  const invalidPatch = Resource.repository(PagedTodos).patch("1", { title: "" })
  const invalid = yield* Effect.result(invalidPatch)
  const invalidFailed = Result.isFailure(invalid)

  expect(invalidFailed).toBe(true)

  const todo = yield* Resource.repository(PagedTodos).get("1")

  expect(todo).toMatchObject({ id: "1", title: "alpha" })
})

it.effect("identifier cursors preserve filtered page boundaries and patch keeps keys immutable and rows valid", () => pipe(pagedCrudProgram, Effect.provide(sqlite)))

it.effect("generated cursors reject a different declared ordering for the same table", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([cursorAscendingTodosTable])
    yield* Resource.repository(CursorAscendingTodos).create({ id: "1", title: "alpha", completed: false })
    yield* Resource.repository(CursorAscendingTodos).create({ id: "2", title: "zulu", completed: false })

    const first = yield* Resource.repository(CursorAscendingTodos).list({ limit: 1 })
    const cursor = yield* pipe(Option.fromNullishOr(first.nextCursor), Effect.fromOption)
    const result = yield* pipe(Resource.repository(CursorDescendingTodos).list({ limit: 1, cursor }), Effect.result)
    const rejected = Result.isFailure(result)

    expect(rejected).toBe(true)
  }),
  Effect.provide(sqlite),
))

const orderedCrudProgram = Effect.gen(function* () {
  yield* prepareTables([orderedTodosTable])

  const database = yield* SqlClient.SqlClient
  const invalidCreateEffect = Resource.repository(OrderedTodos).create({ lower: 4, upper: 1 })
  const invalidCreate = yield* Effect.result(invalidCreateEffect)
  const invalidCreateFailed = Result.isFailure(invalidCreate)

  expect(invalidCreateFailed).toBe(true)

  const created = yield* Resource.repository(OrderedTodos).create({ lower: 1, upper: 4 })
  const invalidUpdateEffect = Resource.repository(OrderedTodos).update({ ...created, lower: 4, upper: 1 })
  const invalidUpdate = yield* Effect.result(invalidUpdateEffect)
  const invalidPatchEffect = Resource.repository(OrderedTodos).patch(created.id, { lower: 4 })
  const invalidPatch = yield* Effect.result(invalidPatchEffect)
  const invalidUpdateFailed = Result.isFailure(invalidUpdate)
  const invalidPatchFailed = Result.isFailure(invalidPatch)

  expect(invalidUpdateFailed).toBe(true)
  expect(invalidPatchFailed).toBe(true)

  const rows = yield* database<Readonly<{ readonly lower: number; readonly upper: number }>>`
    SELECT lower, upper FROM ${database(orderedTodosTable.name)}
  `

  expect(rows).toEqual([{ lower: 1, upper: 4 }])
})

it.effect(
  "implicit identifiers preserve canonical checks for SQLite create, update, and patch",
  () => pipe(orderedCrudProgram, Effect.provide(sqlite)),
)

const TimestampSchema = Schema.Struct({ id: identifier(Schema.String), at: Schema.DateTimeUtc })

interface Timestamp extends Schema.Schema.Type<typeof TimestampSchema> {}

const timestampCapabilities = [Resource.list({
  filter: ["at"],
  limit: 1,
  publish: false,
})]

const Timestamps = Resource.define({
  name: "timestamp_query_codec",
  schema: TimestampSchema,
  authorization: Authorization.public,
  capabilities: timestampCapabilities,
})

const timestampsTable = Resource.table(Timestamps)

it.effect("timestamp filters use the physical codec across cursor pages", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([timestampsTable])

    const at = yield* pipe(DateTime.make("2026-09-09T00:00:00.000Z"), Effect.fromOption)
    const different = yield* pipe(DateTime.make("2026-09-10T00:00:00.000Z"), Effect.fromOption)

    yield* Resource.repository(Timestamps).create({ id: "a", at })
    yield* Resource.repository(Timestamps).create({ id: "b", at: different })
    yield* Resource.repository(Timestamps).create({ id: "c", at })

    const first = yield* Resource.repository(Timestamps).list({ filter: { at } })
    const firstIds = Array.map(first.items, Struct.get("id"))

    expect(firstIds).toEqual(["a"])

    const cursor = yield* pipe(Option.fromNullishOr(first.nextCursor), Effect.fromOption)
    const second = yield* Resource.repository(Timestamps).list({ filter: { at }, cursor })
    const secondIds = Array.map(second.items, Struct.get("id"))

    expect(secondIds).toEqual(["c"])
    expect(second.nextCursor).toBeNull()
  }),
  Effect.provide(sqlite),
))

const EncodedNumberSchema = Schema.Struct({ id: identifier(Schema.NumberFromString), quantity: Schema.Number })

interface EncodedNumber extends Schema.Schema.Type<typeof EncodedNumberSchema> {}

it("rejects generated list for an identifier with a semantic order-breaking codec", () => {
  const capabilities = [Resource.list()]

  const definition = Resource.define({
    name: "semantic_numeric_order",
    schema: EncodedNumberSchema,
    authorization: Authorization.public,
    capabilities,
  })

  expect(() => Resource.compile(definition)).toThrow()
})

const PatchNamedKeySchema = Schema.Struct({
  patch: identifier(Schema.String),
  key: Schema.String,
  changes: Schema.String,
})

interface PatchNamedKey extends Schema.Schema.Type<typeof PatchNamedKeySchema> {}

const patchNamedKeyCapabilities = [Resource.patch()]

const PatchNamedKeys = Resource.define({
  name: "patch_named_keys",
  schema: PatchNamedKeySchema,
  authorization: Authorization.public,
  capabilities: patchNamedKeyCapabilities,
})

const patchNamedKeysTable = Resource.table(PatchNamedKeys)
const PatchNamedKeysRuntime = Resource.compile(PatchNamedKeys)

it.effect("generated patch envelopes cannot collide with canonical field names", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([patchNamedKeysTable])
    yield* Resource.repository(PatchNamedKeys).create({ patch: "row", key: "before-key", changes: "before-changes" })

    const procedure = yield* pipe(
      PatchNamedKeysRuntime.group.requests.get("patch_named_keys.patch"),
      Option.fromUndefinedOr,
      Effect.fromOption,
    )

    const decoded = yield* Schema.decodeUnknownEffect(procedure.payloadSchema)({
      key: "row",
      changes: { key: "after-key", changes: "after-changes" },
    })

    const client = yield* RpcTest.makeClient(PatchNamedKeysRuntime.group)

    yield* client["patch_named_keys.patch"](decoded)

    const stored = yield* Resource.repository(PatchNamedKeys).get("row")

    expect(stored).toEqual({ patch: "row", key: "after-key", changes: "after-changes" })
  }),
  Effect.provide(PatchNamedKeysRuntime.handlers),
  Effect.provide(sqlite),
  Effect.scoped,
))

it("compiled creation inspection and input agree on implicit generation and defaults", () => {
  const parts = [Part.resource(GeneratedTodos)]
  const definition = Application.define({ name: "creation-product", parts })
  const application = Effect.runSync(Application.compile(definition))
  const inspection = ApplicationInspect.describe(application)

  expect(inspection.resources).toMatchObject([{ creation: { defaults: { completed: false }, generated: { id: "uuidV7" }, fromSubject: {} } }])

  const valid = Schema.is(GeneratedTodosRuntime.createInputSchema)
  const absentDefault = valid({ title: "draft" })
  const suppliedDefault = valid({ title: "draft", completed: true })
  const suppliedGeneration = valid({ id: "forbidden", title: "draft" })

  expect(absentDefault).toBe(true)
  expect(suppliedDefault).toBe(true)
  expect(suppliedGeneration).toBe(false)
})

it("creation configuration cannot redeclare an implicit identifier", () => {
  const idGeneration = Resource.generated("uuidV7")
  const sources = Object.freeze({ id: idGeneration })
  const capabilities = [Resource.create({ sources })]

  const definition = new Data.Class({
    name: "implicit-generation-override",
    schema: GeneratedTodoSchema,
    authorization: Authorization.public,
    capabilities,
  })

  const spec = Reflect.apply(Resource.define, null, [definition])

  expect(() => Resource.compile(spec)).toThrow()
})

const GeneratedRecordSchema = Schema.Struct({ id: identifier(Schema.String), at: Schema.DateTimeUtc, summary: Schema.NullOr(Schema.String) })

interface GeneratedRecord extends Schema.Schema.Type<typeof GeneratedRecordSchema> {}

const summaryDefault = Resource.default(null)
const idGeneration = Resource.generated("uuidV7")
const timestampGeneration = Resource.generated("now")

const generatedRecordSources = Object.freeze({
  summary: summaryDefault,
  id: idGeneration,
  at: timestampGeneration,
})

const generatedRecordCapabilities = [Resource.create({ sources: generatedRecordSources })]

const GeneratedRecords = Resource.define({
  name: "creation_runtime_product",
  schema: GeneratedRecordSchema,
  authorization: Authorization.public,
  capabilities: generatedRecordCapabilities,
})

const generatedRecordsTable = Resource.table(GeneratedRecords)
const GeneratedRecordsRepository = Resource.repository(GeneratedRecords)

it.effect("creation plans evaluate runtime generators per call and default only absent inputs", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([generatedRecordsTable])

    const counter = yield* Ref.make(0)
    const at = yield* pipe(DateTime.make("2026-09-10T00:00:00.000Z"), Effect.fromOption)

    const values = Value.of({
      uuidV7: Effect.fn("Test.uuidV7")(function* () {
        const value = yield* Ref.updateAndGet(counter, (value) => value + 1)

        return `generated-${value}`
      }),
      now: Effect.fn("Test.now")(function* () { return at }),
    })

    const create = (input: Parameters<typeof GeneratedRecordsRepository.create>[0]) =>
      pipe(GeneratedRecordsRepository.create(input), Effect.provideService(Value, values))

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

const VersionedTodoSchema = Schema.Struct({
  id: identifier(Schema.String),
  title: Schema.NonEmptyString,
  summary: Schema.NullOr(Schema.String),
  rank: Schema.Int,
  version: Schema.Int,
})

const versionedTodoCapabilities = [
  Resource.create(),
  Resource.update(),
  Resource.patch(),
  Resource.list({
    range: ["rank"],
    order: [["rank", "desc"]],
    limit: 2,
    publish: false,
  }),
]

const VersionedTodos = Resource.define({
  authorization: Authorization.public,
  name: "versioned_todos",
  schema: VersionedTodoSchema,
  version: "version",
  capabilities: versionedTodoCapabilities,
})

const versionedTodosTable = Resource.table(VersionedTodos)

it.effect("nullable create fields default to null, version writes are guarded, and ranged descending pages keyset correctly", () => pipe(

  Effect.gen(function* () {
    yield* prepareTables([versionedTodosTable])

    const first = yield* Resource.repository(VersionedTodos).create({ id: "a", title: "a", rank: 3 })

    yield* Resource.repository(VersionedTodos).create({ id: "b", title: "b", rank: 2 })
    yield* Resource.repository(VersionedTodos).create({ id: "c", title: "c", rank: 1 })
    expect(first).toMatchObject({ summary: null, version: 1 })

    const page = yield* Resource.repository(VersionedTodos).list({ range: { rank: { from: 1, to: 3 } } })
    const pageIdentifiers = Array.map(page.items, Struct.get("id"))

    expect(pageIdentifiers).toEqual(["a", "b"])

    const cursor = yield* Effect.fromNullishOr(page.nextCursor)
    const next = yield* Resource.repository(VersionedTodos).list({ range: { rank: { from: 1, to: 3 } }, cursor })
    const nextIdentifiers = Array.map(next.items, Struct.get("id"))

    expect(nextIdentifiers).toEqual(["c"])

    const patched = yield* Resource.repository(VersionedTodos).patch("a", { title: "patched" }, 1)

    expect(patched.version).toBe(2)

    const patchConflictEffect = Resource.repository(VersionedTodos).patch("a", { title: "stale" }, 1)
    const patchConflict = yield* Effect.result(patchConflictEffect)

    expect(patchConflict).toMatchObject({ _tag: "Failure", failure: { _tag: "VersionConflict", expectedVersion: 1 } })

    const updateConflictEffect = Resource.repository(VersionedTodos).update({ ...first, title: "stale update" })
    const updateConflict = yield* Effect.result(updateConflictEffect)

    expect(updateConflict).toMatchObject({ _tag: "Failure", failure: { _tag: "VersionConflict", expectedVersion: 1 } })
  }),
  Effect.provide(sqlite),
))

it("rejects Boolean and Number version fields at resource definition time", () => {
  const booleanVersionSchema = Schema.Struct({ id: identifier(Schema.String), version: Schema.Boolean })
  const numberVersionSchema = Schema.Struct({ id: identifier(Schema.String), version: Schema.Number })

  const booleanVersionDefinition = Resource.define({
    authorization: Authorization.public,
    name: "boolean_version",
    schema: booleanVersionSchema,
    version: "version",
    capabilities: [],
  })

  const numberVersionDefinition = Resource.define({
    authorization: Authorization.public,
    name: "number_version",
    schema: numberVersionSchema,
    version: "version",
    capabilities: [],
  })

  expect(() => Resource.compile(booleanVersionDefinition)).toThrow()
  expect(() => Resource.compile(numberVersionDefinition)).toThrow()
})

const EnsuredTodoSchema = Schema.Struct({ id: identifier(Schema.String), title: Schema.String })

const EnsuredTodos = Resource.define({
  authorization: Authorization.public,
  name: "ensured_todos",
  schema: EnsuredTodoSchema,
  capabilities: [],
})

const ensuredTodosTable = Resource.table(EnsuredTodos)

const ImplicitEnsuredTodoSchema = Schema.Struct({ title: Schema.String })

const ImplicitEnsuredTodos = Resource.define({
  authorization: Authorization.public,
  name: "implicit_ensured_todos",
  schema: ImplicitEnsuredTodoSchema,
  capabilities: [],
})

const implicitEnsuredTodosTable = Resource.table(ImplicitEnsuredTodos)

it.effect("ensure returns the first authorized row without a duplicate insert", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([ensuredTodosTable, versionedTodosTable, implicitEnsuredTodosTable])

    const inserted = yield* Resource.repository(EnsuredTodos).ensure({ id: "same", title: "first" })
    const repeated = yield* Resource.repository(EnsuredTodos).ensure({ id: "same", title: "second" })

    expect(repeated).toEqual(inserted)

    const versioned = yield* Resource.repository(VersionedTodos).ensure({ id: "versioned", title: "versioned", summary: null, rank: 0, version: 1 })

    expect(versioned).toMatchObject({ id: "versioned", version: 1 })

    const implicit = yield* Resource.repository(ImplicitEnsuredTodos).ensure({ id: "01890f6e-0000-7000-8000-000000000000", title: "implicit" })

    expect(implicit).toMatchObject({ id: "01890f6e-0000-7000-8000-000000000000", title: "implicit" })
  }),
  Effect.provide(sqlite),
))

const ReservationStatusSchema = Schema.Literals(["held", "confirmed", "released"])

const ReservationTransitions = Transitions.make({
  name: "Reservation",
  field: "status",
  status: ReservationStatusSchema,
  transitions: {
    confirm: { from: ["held"], to: "confirmed" },
    release: { from: ["held"], to: "released" },
  },
})

const ReservationSchema = Schema.Struct({
  id: identifier(Schema.String),
  status: ReservationStatusSchema,
  note: Schema.String,
  version: Schema.Int,
})

const reservationCapabilities = [Resource.create(), Resource.transition()]

const Reservations = Resource.define({
  authorization: Authorization.public,
  name: "reservations",
  schema: ReservationSchema,
  version: "version",
  transitions: ReservationTransitions,
  capabilities: reservationCapabilities,
})

const reservationsTable = Resource.table(Reservations)
const ReservationsRuntime = Resource.compile(Reservations)

it.effect("transitions reject an invalid source state and atomically publish the target state", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([reservationsTable])

    const held = yield* Resource.repository(Reservations).create({ id: "reservation", status: "held", note: "draft" })
    const procedure = yield* pipe(ReservationsRuntime.group.requests.get("reservations.transition"), Option.fromUndefinedOr, Effect.fromOption)
    const decodePayload = Schema.decodeUnknownEffect(procedure.payloadSchema)
    const prohibitedPayload = decodePayload({ key: held.id, action: "confirm", expectedVersion: held.version, changes: { status: "confirmed" } })
    const prohibitedStatus = yield* Effect.result(prohibitedPayload)
    const prohibitedStatusFailed = Result.isFailure(prohibitedStatus)

    expect(prohibitedStatusFailed).toBe(true)

    const client = yield* RpcTest.makeClient(ReservationsRuntime.group)
    const confirmed = yield* client["reservations.transition"]({ key: held.id, action: "confirm", changes: { note: "confirmed" }, expectedVersion: held.version })

    expect(confirmed).toMatchObject({ status: "confirmed", note: "confirmed", version: 2 })

    const rejectedTransition = Resource.repository(Reservations).transition(held.id, "release", {}, confirmed.version)
    const rejected = yield* Effect.result(rejectedTransition)

    expect(rejected).toMatchObject({ _tag: "Failure", failure: { _tag: "InvalidReservationTransition", actual: "confirmed", action: "release" } })
  }),
  Effect.provide(ReservationsRuntime.handlers),
  Effect.provide(sqlite),
  Effect.scoped,
))

it("resource inspection includes list policy, version, transitions, and implicit defaults", () => {
  const parts = [Part.resource(VersionedTodos), Part.resource(Reservations)]
  const definition = Application.define({ name: "resource-inspection", parts })
  const application = Effect.runSync(Application.compile(definition))
  const inspection = ApplicationInspect.describe(application)

  expect(inspection.resources).toMatchObject([
    { name: "versioned_todos", creation: { defaults: { summary: null } }, list: { range: ["rank"], order: [["rank", "desc"]], limit: 2 }, version: "version" },
    { name: "reservations", version: "version", transitions: { field: "status", transitions: ReservationTransitions.transitions } },
  ])
})
