import { BunServices } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { existsSync, mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, FileSystem, Function, pipe, Result, Schema } from "effect"
import { Command } from "effect/unstable/cli"
import { Table } from "../src/table.ts"
import { renderCreateTable } from "../src/sqlite-ddl.ts"
import { SqlClient } from "effect/unstable/sql"
import { SchemaStore } from "../src/migrations.ts"
import { Resource } from "../src/resource.ts"
import { SqliteBunRuntime } from "../src/sqlite-bun.ts"
import {
  makeMigrationStore,
  SqliteBackfill,
  SqliteMigrations,
  SqliteRename,
  SqliteSchemaSnapshot,
  SqliteMigration,
  SqliteTransform,
} from "../src/sqlite-migrations.ts"

const empty = SqliteSchemaSnapshot.make({ version: 1, tables: [] })
const sqliteClient = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })

const SqliteMigrationJsonSchema = Schema.toCodecJson(SqliteMigration)
const encodeMigration = Schema.encodeUnknownSync(SqliteMigrationJsonSchema)

const TitleSchema = Schema.Struct({ title: Schema.NonEmptyString })

interface Title extends Schema.Schema.Type<typeof TitleSchema> {}

const nullableAdditionsAndRenamesAction = Effect.fn(
  "SqliteMigrations.nullableAdditionsAndRenames",
)(function* () {
  const database = yield* SqlClient.SqlClient

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
    const database = yield* SqlClient.SqlClient
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
    const initial = SqliteMigrations.plan({ id: "001_drift", from: empty, to: source })
    const store = makeMigrationStore(database, [initial])
    yield* store.prepare(source.tables)
    yield* database`DROP TABLE labels`
    yield* pipe(
      database`${database.literal(renderCreateTable(Table.snapshot(changed.table)))}`,
      Effect.asVoid,
    )
    const record = yield* changed.repository.create({ label: "two spaces" })
    const outcome = yield* Effect.result(store.prepare(source.tables))
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

const missingInitialHistoryAction = Effect.fn(
  "SqliteMigrations.missingInitialHistory",
)(function* () {
  const database = yield* SqlClient.SqlClient
  const resource = Resource.make({
    name: "requires_initial_history",
    schema: TitleSchema,
    operations: [],
  })
  const target = SqliteMigrations.snapshot([resource.table])
  const outcome = yield* Effect.result(makeMigrationStore(database, []).prepare(target.tables))
  const tables = yield* database`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'requires_initial_history'
  `

  expect(outcome).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "MigrationError",
    },
  })
  expect(tables).toEqual([])
})()

it.effect(
  "nonempty schemas reject missing initial migration history instead of initializing tables",
  () => pipe(missingInitialHistoryAction, Effect.provide(sqliteClient)),
)

const failedTransformsRollBackAction = Effect.fn(
  "SqliteMigrations.failedTransformsRollBack",
)(function* () {
  const database = yield* SqlClient.SqlClient

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

const generatedHistoryIsNeverRegisteredOnFailure = Effect.fn(
  "SqliteMigrations.generatedHistoryIsNeverRegisteredOnFailure",
)(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempDisposableSync(join(tmpdir(), "effect-domains-migrations-"))),
    (directory) => Effect.sync(() => directory.remove()),
  )
  const manifest = join(directory.path, "manifest.json")
  const initialPath = join(directory.path, "001_initial.json")
  const InitialSchema = Schema.Struct({ title: Schema.String })
  const TargetSchema = Schema.Struct({
    title: Schema.String,
    required: Schema.Number,
  })
  const initialResource = Resource.make({
    name: "generated_history",
    schema: InitialSchema,
    operations: [],
  })
  const targetResource = Resource.make({
    name: "generated_history",
    schema: TargetSchema,
    operations: [],
  })
  const initial = SqliteMigrations.plan({
    id: "001_initial",
    from: empty,
    to: SqliteMigrations.snapshot([initialResource.table]),
  })
  const encodedInitial = encodeMigration(initial)
  const history = SqliteMigrations.history([encodedInitial])
  writeFileSync(initialPath, JSON.stringify(encodedInitial, null, 2))
  writeFileSync(
    manifest,
    JSON.stringify({ migrations: ["001_initial.json"] }, null, 2),
  )
  const initialBytes = readFileSync(initialPath, "utf8")
  const accepted = SqliteMigrations.command({
    name: "schema",
    tables: [initialResource.table],
    migrations: history,
    manifest,
  })
  const generated = yield* Effect.exit(
    Command.runWith(accepted, { version: "test", renderErrors: false })([
      "generate",
      "reviewed",
    ]),
  )

  expect(generated._tag).toBe("Success")
  expect(existsSync(join(directory.path, "002_reviewed.json"))).toBe(true)
  const generatedHistory = yield* SqliteMigrations.load(manifest)
  expect(generatedHistory).toHaveLength(2)
  expect(Object.isFrozen(generatedHistory)).toBe(true)

  const before = readFileSync(manifest, "utf8")
  const fileSystem = yield* FileSystem.FileSystem
  const bookkeepingFailureFileSystem = {
    ...fileSystem,
    rename: (from: string, to: string) =>
      to === manifest ? Effect.die("simulated manifest rename failure") : fileSystem.rename(from, to),
  }
  const bookkeeping = SqliteMigrations.command({
    name: "schema",
    tables: [initialResource.table],
    migrations: generatedHistory,
    manifest,
  })
  const bookkeepingFailure = yield* Effect.exit(
    pipe(
      Command.runWith(bookkeeping, { version: "test", renderErrors: false })([
        "generate",
        "bookkeeping",
      ]),
      Effect.provideService(FileSystem.FileSystem, bookkeepingFailureFileSystem),
    ),
  )

  expect(bookkeepingFailure._tag).toBe("Failure")
  expect(readFileSync(manifest, "utf8")).toBe(before)
  expect(readFileSync(initialPath, "utf8")).toBe(initialBytes)
  expect(existsSync(join(directory.path, "003_bookkeeping.json"))).toBe(true)
  const historyAfterBookkeepingFailure = yield* SqliteMigrations.load(manifest)
  expect(historyAfterBookkeepingFailure).toHaveLength(2)

  const command = SqliteMigrations.command({
    name: "schema",
    tables: [targetResource.table],
    migrations: generatedHistory,
    manifest,
  })
  const blocked = yield* Effect.exit(
    Command.runWith(command, { version: "test", renderErrors: false })([
      "generate",
      "required",
    ]),
  )

  expect(blocked._tag).toBe("Failure")
  expect(readFileSync(manifest, "utf8")).toBe(before)
  expect(existsSync(join(directory.path, "003_required.json"))).toBe(false)

  const incoherent = SqliteMigrations.command({
    name: "schema",
    tables: [initialResource.table],
    migrations: [],
    manifest,
  })
  const incoherentFailure = yield* Effect.exit(
    Command.runWith(incoherent, { version: "test", renderErrors: false })([
      "generate",
      "reviewed",
    ]),
  )

  expect(incoherentFailure._tag).toBe("Failure")
  expect(readFileSync(manifest, "utf8")).toBe(before)
  expect(existsSync(join(directory.path, "003_reviewed.json"))).toBe(false)
  const repeat = SqliteMigrations.plan({
    id: "002_repeat",
    from: initial.to,
    to: initial.to,
  })
  const final = SqliteMigrations.plan({
    id: "001_final",
    from: repeat.to,
    to: repeat.to,
  })
  const encodedRepeat = encodeMigration(repeat)
  const encodedFinal = encodeMigration(final)
  const nonMonotonicHistory = SqliteMigrations.history([
    encodedInitial,
    encodedRepeat,
    encodedFinal,
  ])
  writeFileSync(join(directory.path, "seed.json"), JSON.stringify(encodedRepeat, null, 2))
  writeFileSync(join(directory.path, "final.json"), JSON.stringify(encodedFinal, null, 2))
  writeFileSync(
    manifest,
    JSON.stringify(
      { migrations: ["001_initial.json", "seed.json", "final.json"] },
      null,
      2,
    ),
  )
  const duplicateBefore = readFileSync(manifest, "utf8")
  const duplicateId = SqliteMigrations.command({
    name: "schema",
    tables: [initialResource.table],
    migrations: nonMonotonicHistory,
    manifest,
  })
  const duplicateIdFailure = yield* Effect.exit(
    Command.runWith(duplicateId, { version: "test", renderErrors: false })([
      "generate",
      "repeat",
    ]),
  )

  expect(duplicateIdFailure._tag).toBe("Failure")
  expect(readFileSync(manifest, "utf8")).toBe(duplicateBefore)
  expect(existsSync(join(directory.path, "002_repeat.json"))).toBe(false)
})

it.effect(
  "generate leaves the manifest unchanged for blocked, incoherent, and duplicate histories",
  () => pipe(
    generatedHistoryIsNeverRegisteredOnFailure(),
    Effect.provide(BunServices.layer),
  ),
)
