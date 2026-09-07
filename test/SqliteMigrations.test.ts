import { expect, it } from "@effect/vitest"
import { Effect, Function, pipe, Result, Schema } from "effect"
import { SchemaStore } from "../src/migrations.ts"
import { Resource } from "../src/resource.ts"
import { Database, SqliteBunRuntime } from "../src/sqlite-bun.ts"
import {
  makeMigrationStore,
  SqliteBackfill,
  SqliteMigrations,
  SqliteRename,
  SqliteSchemaSnapshot,
  SqliteTransform,
} from "../src/sqlite-migrations.ts"

const empty = SqliteSchemaSnapshot.make({ version: 1, tables: [] })
const sqliteClient = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })

const TitleSchema = Schema.Struct({ title: Schema.NonEmptyString })

interface Title extends Schema.Schema.Type<typeof TitleSchema> {}

const nullableAdditionsAndRenamesAction = Effect.fn(
  "SqliteMigrations.nullableAdditionsAndRenames",
)(function* () {
  const database = yield* Database

  const before = Resource.make({
    name: "documents",
    schema: TitleSchema,
    operations: [],
  })

  const NullableCommentSchema = Schema.NullOr(Schema.String)

  const NullableDocumentSchema = Schema.Struct({
    comment: NullableCommentSchema,
    ...before.schema.fields,
  })

  interface NullableDocument extends Schema.Schema.Type<typeof NullableDocumentSchema> {}

  const nullable = Resource.make({
    name: "documents",
    schema: NullableDocumentSchema,
    operations: [],
  })

  const isNonNegative = Schema.isGreaterThanOrEqualTo(0)
  const NonNegativeIntSchema = Schema.Int.check(isNonNegative)

  const RenamedDocumentSchema = Schema.Struct({
    comment: nullable.schema.fields.comment,
    heading: before.schema.fields.title,
    priority: NonNegativeIntSchema,
  })

  interface RenamedDocument extends Schema.Schema.Type<typeof RenamedDocumentSchema> {}

  const renamed = Resource.make({
    name: "documents",
    schema: RenamedDocumentSchema,
    operations: [],
  })


  const source = SqliteMigrations.snapshot([before.table])
  const withComment = SqliteMigrations.snapshot([nullable.table])
  const target = SqliteMigrations.snapshot([renamed.table])
  const initial = SqliteMigrations.plan({ id: "001", from: empty, to: source })
  const addition = SqliteMigrations.plan({ id: "002", from: source, to: withComment })
  const unresolved = SqliteMigrations.plan({ id: "003", from: withComment, to: target })
  const blockedChange = expect.objectContaining({ _tag: "SqliteBlockedChange" })

  expect(unresolved.steps).toContainEqual(blockedChange)

  const rename = SqliteRename.make({ table: "documents", from: "title", to: "heading" })
  const backfill = SqliteBackfill.make({ table: "documents", column: "priority", value: 0 })

  const change = SqliteMigrations.plan({
    id: "003",
    from: withComment,
    to: target,
    renames: [rename],
    backfills: [backfill],
  })

  const initialStore = makeMigrationStore(database, [initial])
  yield* initialStore.prepare(source.tables)
  const document = yield* before.repository.create({ title: "preserve me" })
  const additionStore = makeMigrationStore(database, [initial, addition])
  yield* additionStore.prepare(withComment.tables)
  const nullableDocument = yield* nullable.repository.get(document.id)
  const store = makeMigrationStore(database, [initial, addition, change])
  yield* store.prepare(target.tables)
  yield* store.prepare(target.tables)
  const renamedDocument = yield* renamed.repository.get(document.id)

  expect(nullableDocument).toEqual({ ...document, comment: null })
  expect(renamedDocument).toEqual({
    id: document.id,
    heading: document.title,
    comment: null,
    priority: 0,
  })
})()

const nullableAdditionsAndRenames = pipe(
  nullableAdditionsAndRenamesAction,
  Effect.provide(sqliteClient),
)

const nullableAdditionsAndRenamesTest = Function.constant(
  nullableAdditionsAndRenames,
)

it.effect(
  "nullable additions and explicit renames preserve records regardless of declaration order",
  nullableAdditionsAndRenamesTest,
)

const driftDetectionAction = Effect.fn("SqliteMigrations.driftDetection")(
  function* () {
    const database = yield* Database
    const store = yield* SchemaStore
    const OriginalLabelSchema = Schema.Literal("two  spaces")
    const OriginalSchema = Schema.Struct({ label: OriginalLabelSchema })
    interface Original extends Schema.Schema.Type<typeof OriginalSchema> {}

    const original = Resource.make({
      name: "labels",
      schema: OriginalSchema,
      operations: [],
    })

    const ChangedLabelSchema = Schema.Literal("two spaces")
    const ChangedSchema = Schema.Struct({ label: ChangedLabelSchema })
    interface Changed extends Schema.Schema.Type<typeof ChangedSchema> {}

    const changed = Resource.make({
      name: "labels",
      schema: ChangedSchema,
      operations: [],
    })


    const source = SqliteMigrations.snapshot([original.table])
    yield* store.prepare(source.tables)
    yield* database`DROP TABLE labels`
    yield* changed.table.write()
    const record = yield* changed.repository.create({ label: "two spaces" })
    const prepare = store.prepare(source.tables)
    const outcome = yield* Effect.result(prepare)
    const loadedRecord = yield* changed.repository.get(record.id)

    expect(outcome).toMatchObject({ _tag: "Failure", failure: { _tag: "MigrationError" } })
    expect(loadedRecord).toEqual(record)
  },
)()

const driftDetection = pipe(driftDetectionAction, Effect.provide(sqliteClient))

const driftDetectionTest = Function.constant(driftDetection)

it.effect(
  "drift detection preserves whitespace inside SQL constraint literals",
  driftDetectionTest,
)

const failedTransformsRollBackAction = Effect.fn(
  "SqliteMigrations.failedTransformsRollBack",
)(function* () {
  const database = yield* Database

  const before = Resource.make({
    name: "jobs",
    schema: TitleSchema,
    operations: [],
  })

  const isPositive = Schema.isGreaterThan(0)
  const PositiveIntSchema = Schema.Int.check(isPositive)

  const JobSchema = Schema.Struct({
    ...before.schema.fields,
    priority: PositiveIntSchema,
  })

  interface Job extends Schema.Schema.Type<typeof JobSchema> {}

  const after = Resource.make({
    name: "jobs",
    schema: JobSchema,
    operations: [],
  })


  const source = SqliteMigrations.snapshot([before.table])
  const target = SqliteMigrations.snapshot([after.table])
  const initial = SqliteMigrations.plan({ id: "001", from: empty, to: source })

  const invalidTransform = SqliteTransform.make({
    table: "jobs",
    column: "priority",
    expression: "-1",
  })

  const invalid = SqliteMigrations.plan({
    id: "002",
    from: source,
    to: target,
    transforms: [invalidTransform],
  })

  const initialStore = makeMigrationStore(database, [initial])
  yield* initialStore.prepare(source.tables)
  const job = yield* before.repository.create({ title: "keep me" })
  const failedStore = makeMigrationStore(database, [initial, invalid])
  const failedPrepare = failedStore.prepare(target.tables)
  const outcome = yield* Effect.result(failedPrepare)
  const failed = Result.isFailure(outcome)
  const rollbackStore = makeMigrationStore(database, [initial])
  yield* rollbackStore.prepare(source.tables)
  const restoredJob = yield* before.repository.get(job.id)

  expect(failed).toBe(true)
  expect(restoredJob).toEqual(job)

  const correctedBackfill = SqliteBackfill.make({ table: "jobs", column: "priority", value: 1 })

  const corrected = SqliteMigrations.plan({
    id: "002",
    from: source,
    to: target,
    backfills: [correctedBackfill],
  })

  const correctedStore = makeMigrationStore(database, [initial, corrected])
  yield* correctedStore.prepare(target.tables)
  const migratedJob = yield* after.repository.get(job.id)

  expect(migratedJob).toEqual({ ...job, priority: 1 })
})()

const failedTransformsRollBack = pipe(
  failedTransformsRollBackAction,
  Effect.provide(sqliteClient),
)

const failedTransformsRollBackTest = Function.constant(
  failedTransformsRollBack,
)

it.effect(
  "failed transforms roll back table data and migration history before a corrected retry",
  failedTransformsRollBackTest,
)
