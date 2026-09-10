import { Authorization } from "effect-domains/authorization"
import { BunServices } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { existsSync, mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Array, Effect, Equivalence, FileSystem, Function, Option, pipe, Record, Result, Schema, Struct } from "effect"
import { Command } from "effect/unstable/cli"
import { Table, TableField, TableSnapshot } from "effect-domains/table"
import { renderCreateTable } from "../packages/effect-domains/src/sqlite-ddl.ts"
import { SqlClient } from "effect/unstable/sql"
import { SchemaStore } from "effect-domains/migrations"
import { Resource } from "effect-domains/resource"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { makeMigrationStore, SqliteMigrations, SqliteMigration } from "effect-domains/sqlite-migrations"

const empty = SqliteMigrations.snapshot([])
const sqliteClient = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })
const SqliteMigrationJsonSchema = Schema.toCodecJson(SqliteMigration)
const encodeMigration = Schema.encodeUnknownSync(SqliteMigrationJsonSchema)
const TitleSchema = Schema.Struct({ title: Schema.NonEmptyString })
interface Title extends Schema.Schema.Type<typeof TitleSchema> {}

const nullableAdditionsAndRenamesAction = Effect.fn("SqliteMigrations.nullableAdditionsAndRenames")(function* () {
  const database = yield* SqlClient.SqlClient
  const before = Resource.make({ authorization: Authorization.public, name: "documents", schema: TitleSchema, operations: {} })
  const NullableCommentSchema = Schema.NullOr(Schema.String)

  const NullableDocumentSchema = Schema.Struct({
    comment: NullableCommentSchema,
    ...before.schema.fields,
  })

  interface NullableDocument extends Schema.Schema.Type<typeof NullableDocumentSchema> {}
  const nullable = Resource.make({ authorization: Authorization.public, name: "documents", schema: NullableDocumentSchema, operations: {} })
  const isNonNegative = Schema.isGreaterThanOrEqualTo(0)
  const NonNegativeIntSchema = Schema.Int.check(isNonNegative)

  const RenamedDocumentSchema = Schema.Struct({
    comment: nullable.schema.fields.comment,
    heading: before.schema.fields.title,
    priority: NonNegativeIntSchema,
  })

  interface RenamedDocument extends Schema.Schema.Type<typeof RenamedDocumentSchema> {}
  const renamed = Resource.make({ authorization: Authorization.public, name: "documents", schema: RenamedDocumentSchema, operations: {} })
  const source = SqliteMigrations.snapshot([before.table])
  const withComment = SqliteMigrations.snapshot([nullable.table])
  const target = SqliteMigrations.snapshot([renamed.table])
  const initial = SqliteMigrations.plan({ id: "001", from: empty, to: source })
  const addition = SqliteMigrations.plan({ id: "002", from: source, to: withComment })
  const unresolved = SqliteMigrations.plan({ id: "003", from: withComment, to: target })
  const blockedChange = expect.objectContaining({ _tag: "SqliteBlockedChange" })

  expect(unresolved.steps).toContainEqual(blockedChange)

  const SummaryDocumentSchema = Schema.Struct({
    ...before.schema.fields,
    summary: NullableCommentSchema,
  })

  interface SummaryDocument extends Schema.Schema.Type<typeof SummaryDocumentSchema> {}
  const summary = Resource.make({ authorization: Authorization.public, name: "documents", schema: SummaryDocumentSchema, operations: {} })
  const summaryTarget = SqliteMigrations.snapshot([summary.table])

  const impossibleRename = SqliteMigrations.plan({
    id: "invalid_rename",
    from: source,
    to: summaryTarget,
    renames: [{ table: "documents", from: "titel", to: "summary" }],
  })

  expect(impossibleRename.steps).toContainEqual(blockedChange)
  const isAddColumn = (step: (typeof impossibleRename.steps)[number]) => Equivalence.strictEqual<string>()(step._tag, "SqliteAddColumn")
  const hasAddColumn = Array.some(impossibleRename.steps, isAddColumn)
  expect(hasAddColumn).toBe(false)

  const change = SqliteMigrations.plan({
    id: "003",
    from: withComment,
    to: target,
    renames: [{ table: "documents", from: "title", to: "heading" }],
    backfills: [{ table: "documents", column: "priority", value: 0 }],
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

const nullableAdditionsAndRenames = pipe(nullableAdditionsAndRenamesAction, Effect.provide(sqliteClient))
const nullableAdditionsAndRenamesTest = Function.constant(nullableAdditionsAndRenames)

it.effect("nullable additions and explicit renames preserve records regardless of declaration order", nullableAdditionsAndRenamesTest)

const interactingRenamesAction = Effect.fn("SqliteMigrations.interactingRenames")(function* () {
  const database = yield* SqlClient.SqlClient
  const ChainSourceSchema = Schema.Struct({ a: Schema.String, b: Schema.String })
  interface ChainSource extends Schema.Schema.Type<typeof ChainSourceSchema> {}
  const ChainTargetSchema = Schema.Struct({ b: Schema.String, c: Schema.String })
  interface ChainTarget extends Schema.Schema.Type<typeof ChainTargetSchema> {}

  const source = Resource.make({
    authorization: Authorization.public,
    name: "rename_chain",
    schema: ChainSourceSchema,
    operations: {},
  })

  const target = Resource.make({
    authorization: Authorization.public,
    name: "rename_chain",
    schema: ChainTargetSchema,
    operations: {},
  })

  const sourceSnapshot = SqliteMigrations.snapshot([source.table])
  const targetSnapshot = SqliteMigrations.snapshot([target.table])
  const initial = SqliteMigrations.plan({ id: "001_rename_chain", from: empty, to: sourceSnapshot })

  const chain = SqliteMigrations.plan({
    id: "002_rename_chain",
    from: sourceSnapshot,
    to: targetSnapshot,
    renames: [
      { table: "rename_chain", from: "a", to: "b" },
      { table: "rename_chain", from: "b", to: "c" },
    ],
  })

  const initialStore = makeMigrationStore(database, [initial])

  yield* initialStore.prepare(sourceSnapshot.tables)
  const sourceRecord = yield* source.repository.create({ a: "original a", b: "original b" })
  const chainedStore = makeMigrationStore(database, [initial, chain])

  yield* chainedStore.prepare(targetSnapshot.tables)
  const chainedRecord = yield* target.repository.get(sourceRecord.id)

  expect(chainedRecord).toEqual({ id: sourceRecord.id, b: sourceRecord.a, c: sourceRecord.b })

  const CycleSchema = Schema.Struct({ a: Schema.String, b: Schema.String })
  interface Cycle extends Schema.Schema.Type<typeof CycleSchema> {}

  const cycle = Resource.make({
    authorization: Authorization.public,
    name: "rename_cycle",
    schema: CycleSchema,
    operations: {},
  })

  const cycleSnapshot = SqliteMigrations.snapshot([target.table, cycle.table])

  const addCycle = SqliteMigrations.plan({
    id: "003_rename_cycle",
    from: targetSnapshot,
    to: cycleSnapshot,
  })

  const swap = SqliteMigrations.plan({
    id: "004_rename_cycle",
    from: cycleSnapshot,
    to: cycleSnapshot,
    renames: [
      { table: "rename_cycle", from: "a", to: "b" },
      { table: "rename_cycle", from: "b", to: "a" },
    ],
  })

  const cycleStore = makeMigrationStore(database, [initial, chain, addCycle])

  yield* cycleStore.prepare(cycleSnapshot.tables)
  const cycleRecord = yield* cycle.repository.create({ a: "left", b: "right" })
  const swappedStore = makeMigrationStore(database, [initial, chain, addCycle, swap])

  yield* swappedStore.prepare(cycleSnapshot.tables)
  const swappedRecord = yield* cycle.repository.get(cycleRecord.id)

  expect(swappedRecord).toEqual({ id: cycleRecord.id, a: cycleRecord.b, b: cycleRecord.a })
})()

const interactingRenames = pipe(interactingRenamesAction, Effect.provide(sqliteClient))
const interactingRenamesTest = Function.constant(interactingRenames)

it.effect("interacting column renames rebuild from original source values", interactingRenamesTest)

const nullableIdentifierSnapshotsAction = Effect.fn("SqliteMigrations.nullableIdentifierSnapshots")(function* () {
  const temporaryRoot = tmpdir()
  const temporaryPrefix = join(temporaryRoot, "effect-domains-nullable-identifiers-")
  const createDirectory = Effect.sync(() => mkdtempDisposableSync(temporaryPrefix))
  const removeDirectory = (directory: ReturnType<typeof mkdtempDisposableSync>) => Effect.sync(() => directory.remove())
  const directory = yield* Effect.acquireRelease(createDirectory, removeDirectory)

  const resource = Resource.make({
    authorization: Authorization.public,
    name: "nullable_history_identifier",
    schema: TitleSchema,
    operations: {},
  })

  const target = SqliteMigrations.snapshot([resource.table])
  const initial = SqliteMigrations.plan({ id: "nullable_identifier", from: empty, to: target })

  const nullableField = (identifier: string) =>
    (field: TableField) =>
      Equivalence.strictEqual<string>()(field.name, identifier)
        ? TableField.make({ ...field, nullable: true })
        : field

  const nullableTable = (table: TableSnapshot) => {
    const fields = pipe(table.fields, Array.map(nullableField(table.identifier)))
    return TableSnapshot.make({ ...table, fields })
  }

  const nullableTables = pipe(initial.to.tables, Array.map(nullableTable))
  const nullableTarget = SqliteMigration.fields.to.make({ ...initial.to, tables: nullableTables })
  const nullableArtifact = SqliteMigration.make({ ...initial, to: nullableTarget })
  const encodedArtifact = encodeMigration(nullableArtifact)
  const history = SqliteMigrations.decodeHistory([encodedArtifact])
  const decodedHistory = yield* Effect.result(history)

  expect(decodedHistory).toMatchObject({ _tag: "Failure", failure: { _tag: "MigrationError" } })

  const snapshotPath = join(directory.path, "nullable-snapshot.json")
  const jsonArtifact = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(encodedArtifact)
  const encodedTarget = yield* pipe(Record.get(jsonArtifact, "to"), Effect.fromOption)
  const encodedSnapshot = JSON.stringify(encodedTarget)
  writeFileSync(snapshotPath, encodedSnapshot)
  const manifest = Option.none<string>()

  const command = SqliteMigrations.command({
    name: "schema",
    tables: [resource.table],
    manifest,
  })

  const run = Command.runWith(command, { version: "test", renderErrors: false })
  const snapshotPlanning = run(["plan", "--from", snapshotPath, "--id", "invalid_snapshot"])
  const decodedSnapshot = yield* Effect.result(snapshotPlanning)

  expect(decodedSnapshot).toMatchObject({ _tag: "Failure" })
})()

it.effect(
  "nullable identifiers in migration history and snapshots fail validation",
  () => pipe(nullableIdentifierSnapshotsAction, Effect.provide(BunServices.layer)),
)

const repeatableIntentFlagsAction = Effect.fn("SqliteMigrations.repeatableIntentFlags")(function* () {
  const temporaryRoot = tmpdir()
  const temporaryPrefix = join(temporaryRoot, "effect-domains-repeatable-intents-")
  const createDirectory = Effect.sync(() => mkdtempDisposableSync(temporaryPrefix))
  const removeDirectory = (directory: ReturnType<typeof mkdtempDisposableSync>) => Effect.sync(() => directory.remove())
  const directory = yield* Effect.acquireRelease(createDirectory, removeDirectory)
  const sourcePath = join(directory.path, "001_initial.json")
  const artifactPath = join(directory.path, "002_backfills.json")
  const SourceSchema = Schema.Struct({ title: Schema.String })
  interface Source extends Schema.Schema.Type<typeof SourceSchema> {}

  const TargetSchema = Schema.Struct({
    ...SourceSchema.fields,
    label: Schema.String,
    priority: Schema.Int,
  })

  interface Target extends Schema.Schema.Type<typeof TargetSchema> {}
  const source = Resource.make({ authorization: Authorization.public, name: "repeatable_intents", schema: SourceSchema, operations: {} })
  const target = Resource.make({ authorization: Authorization.public, name: "repeatable_intents", schema: TargetSchema, operations: {} })
  const sourceSnapshot = SqliteMigrations.snapshot([source.table])

  const initial = SqliteMigrations.plan({
    id: "001_initial",
    from: empty,
    to: sourceSnapshot,
  })

  const encodedInitial = encodeMigration(initial)
  const initialText = JSON.stringify(encodedInitial, null, 2)
  writeFileSync(sourcePath, initialText)

  const noManifest = Option.none()

  const command = SqliteMigrations.command({
    name: "schema",
    tables: [target.table],
    manifest: noManifest,
  })

  const run = Command.runWith(command, { version: "test", renderErrors: false })

  yield* run([
    "plan",
    "--from",
    sourcePath,
    "--id",
    "002_backfills",
    "--backfill",
    'repeatable_intents:label:"json:colon"',
    "--backfill",
    "repeatable_intents:priority:0",
    "--transform",
    `repeatable_intents:title:replace("title", ':', '-')`,
    "--out",
    artifactPath,
  ])

  const sourceText = readFileSync(sourcePath, "utf8")
  const artifactText = readFileSync(artifactPath, "utf8")
  const sourceJson = JSON.parse(sourceText)
  const artifactJson = JSON.parse(artifactText)
  const [, artifact] = yield* SqliteMigrations.decodeHistory([sourceJson, artifactJson])
  const labelCopy = expect.objectContaining({ _tag: "SqliteColumnValue", column: "label", value: "json:colon" })
  const priorityCopy = expect.objectContaining({ _tag: "SqliteColumnValue", column: "priority", value: 0 })

  const titleCopy = expect.objectContaining({
    _tag: "SqliteColumnExpression",
    column: "title",
    expression: `replace("title", ':', '-')`,
  })

  const copies = expect.arrayContaining([labelCopy, priorityCopy, titleCopy])
  const rebuild = expect.objectContaining({ _tag: "SqliteRebuildTable", copies })
  expect(artifact?.steps).toEqual([rebuild])
})

it.effect(
  "repeatable migration intent flags retain JSON and SQL colons",
  () => pipe(repeatableIntentFlagsAction(), Effect.provide(BunServices.layer)),
)

const driftDetectionAction = Effect.fn("SqliteMigrations.driftDetection")(function* () {
  const database = yield* SqlClient.SqlClient
  const OriginalLabelSchema = Schema.Literal("two  spaces")
  const OriginalSchema = Schema.Struct({ label: OriginalLabelSchema })
  interface Original extends Schema.Schema.Type<typeof OriginalSchema> {}
  const original = Resource.make({ authorization: Authorization.public, name: "labels", schema: OriginalSchema, operations: {} })
  const ChangedLabelSchema = Schema.Literal("two spaces")
  const ChangedSchema = Schema.Struct({ label: ChangedLabelSchema })
  interface Changed extends Schema.Schema.Type<typeof ChangedSchema> {}
  const changed = Resource.make({ authorization: Authorization.public, name: "labels", schema: ChangedSchema, operations: {} })
  const source = SqliteMigrations.snapshot([original.table])
  const initial = SqliteMigrations.plan({ id: "001_drift", from: empty, to: source })
  const store = makeMigrationStore(database, [initial])
  yield* store.prepare(source.tables)
  yield* database`DROP TABLE labels`
  const changedSnapshot = Table.snapshot(changed.table)
  const changedTableSql = renderCreateTable(changedSnapshot)
  const changedTable = database.literal(changedTableSql)
  yield* pipe(database`${changedTable}`, Effect.asVoid)
  const record = yield* changed.repository.create({ label: "two spaces" })
  const prepareSource = store.prepare(source.tables)
  const outcome = yield* Effect.result(prepareSource)
  const loadedRecord = yield* changed.repository.get(record.id)

  expect(outcome).toMatchObject({ _tag: "Failure", failure: { _tag: "MigrationError" } })
  expect(loadedRecord).toEqual(record)
})()

const driftDetection = pipe(driftDetectionAction, Effect.provide(sqliteClient))
const driftDetectionTest = Function.constant(driftDetection)

it.effect("drift detection preserves whitespace inside SQL constraint literals", driftDetectionTest)

const missingInitialHistoryAction = Effect.fn("SqliteMigrations.missingInitialHistory")(function* () {
  const database = yield* SqlClient.SqlClient
  const resource = Resource.make({ authorization: Authorization.public, name: "requires_initial_history", schema: TitleSchema, operations: {} })
  const target = SqliteMigrations.snapshot([resource.table])
  const emptyStore = makeMigrationStore(database, [])
  const prepareTarget = emptyStore.prepare(target.tables)
  const outcome = yield* Effect.result(prepareTarget)

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

it.effect("nonempty schemas reject missing initial migration history instead of initializing tables", () => pipe(missingInitialHistoryAction, Effect.provide(sqliteClient)))

const failedTransformsRollBackAction = Effect.fn("SqliteMigrations.failedTransformsRollBack")(function* () {
  const database = yield* SqlClient.SqlClient
  const before = Resource.make({ authorization: Authorization.public, name: "jobs", schema: TitleSchema, operations: {} })
  const isPositive = Schema.isGreaterThan(0)
  const PositiveIntSchema = Schema.Int.check(isPositive)

  const JobSchema = Schema.Struct({
    ...before.schema.fields,
    priority: PositiveIntSchema,
  })

  interface Job extends Schema.Schema.Type<typeof JobSchema> {}
  const after = Resource.make({ authorization: Authorization.public, name: "jobs", schema: JobSchema, operations: {} })
  const source = SqliteMigrations.snapshot([before.table])
  const target = SqliteMigrations.snapshot([after.table])
  const initial = SqliteMigrations.plan({ id: "001", from: empty, to: source })

  const invalid = SqliteMigrations.plan({
    id: "002",
    from: source,
    to: target,
    transforms: [{ table: "jobs", column: "priority", expression: "-1" }],
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

  const corrected = SqliteMigrations.plan({
    id: "002",
    from: source,
    to: target,
    backfills: [{ table: "jobs", column: "priority", value: 1 }],
  })

  const correctedStore = makeMigrationStore(database, [initial, corrected])
  yield* correctedStore.prepare(target.tables)
  const migratedJob = yield* after.repository.get(job.id)

  expect(migratedJob).toEqual({ ...job, priority: 1 })
})()

const failedTransformsRollBack = pipe(failedTransformsRollBackAction, Effect.provide(sqliteClient))
const failedTransformsRollBackTest = Function.constant(failedTransformsRollBack)

it.effect("failed transforms roll back table data and migration history before a corrected retry", failedTransformsRollBackTest)

const generatedHistoryIsNeverRegisteredOnFailure = Effect.fn("SqliteMigrations.generatedHistoryIsNeverRegisteredOnFailure")(function* () {
  const temporaryRoot = tmpdir()
  const temporaryPrefix = join(temporaryRoot, "effect-domains-migrations-")
  const createDirectory = Effect.sync(() => mkdtempDisposableSync(temporaryPrefix))
  const releaseDirectory = (directory: ReturnType<typeof mkdtempDisposableSync>) => Effect.sync(() => directory.remove())
  const directory = yield* Effect.acquireRelease(createDirectory, releaseDirectory)
  const manifest = join(directory.path, "manifest.json")
  const initialPath = join(directory.path, "001_initial.json")
  const InitialSchema = Schema.Struct({ title: Schema.String })
  interface Initial extends Schema.Schema.Type<typeof InitialSchema> {}

  const TargetSchema = Schema.Struct({
    title: Schema.String,
    required: Schema.Number,
  })

  interface Target extends Schema.Schema.Type<typeof TargetSchema> {}
  const initialResource = Resource.make({ authorization: Authorization.public, name: "generated_history", schema: InitialSchema, operations: {} })
  const targetResource = Resource.make({ authorization: Authorization.public, name: "generated_history", schema: TargetSchema, operations: {} })
  const initialTarget = SqliteMigrations.snapshot([initialResource.table])

  const initial = SqliteMigrations.plan({
    id: "001_initial",
    from: empty,
    to: initialTarget,
  })

  const encodedInitial = encodeMigration(initial)
  const initialText = JSON.stringify(encodedInitial, null, 2)
  writeFileSync(initialPath, initialText)
  const initialManifest = JSON.stringify({ migrations: ["001_initial.json"] }, null, 2)
  writeFileSync(manifest, initialManifest)
  const initialBytes = readFileSync(initialPath, "utf8")
  const manifestOption = Option.some(manifest)

  const accepted = SqliteMigrations.command({
    name: "schema",
    tables: [initialResource.table],
    manifest: manifestOption,
  })

  const acceptedRun = Command.runWith(accepted, { version: "test", renderErrors: false })
  const reviewedGeneration = acceptedRun(["generate", "reviewed"])
  const generated = yield* Effect.exit(reviewedGeneration)
  const reviewedPath = join(directory.path, "002_reviewed.json")
  const reviewedExists = existsSync(reviewedPath)
  expect(generated._tag).toBe("Success")
  expect(reviewedExists).toBe(true)

  const generatedHistory = yield* SqliteMigrations.load(manifest)
  const generatedHistoryFrozen = Object.isFrozen(generatedHistory)
  expect(generatedHistory).toHaveLength(2)
  expect(generatedHistoryFrozen).toBe(true)

  const before = readFileSync(manifest, "utf8")
  const fileSystem = yield* FileSystem.FileSystem

  const renameWithFailure = (from: string, to: string) => {
    const targetsManifest = Equivalence.strictEqual<string>()(to, manifest)
    return targetsManifest ? Effect.die("simulated manifest rename failure") : fileSystem.rename(from, to)
  }

  const bookkeepingFailureFileSystem = {
    ...fileSystem,
    rename: renameWithFailure,
  }

  const bookkeeping = SqliteMigrations.command({
    name: "schema",
    tables: [initialResource.table],
    manifest: manifestOption,
  })

  const bookkeepingRun = Command.runWith(bookkeeping, { version: "test", renderErrors: false })
  const bookkeepingGeneration = bookkeepingRun(["generate", "bookkeeping"])
  const bookkeepingWithFailure = pipe(bookkeepingGeneration, Effect.provideService(FileSystem.FileSystem, bookkeepingFailureFileSystem))
  const bookkeepingFailure = yield* Effect.exit(bookkeepingWithFailure)
  const manifestAfterBookkeepingFailure = readFileSync(manifest, "utf8")
  const initialAfterBookkeepingFailure = readFileSync(initialPath, "utf8")
  const bookkeepingPath = join(directory.path, "003_bookkeeping.json")
  const bookkeepingArtifactExists = existsSync(bookkeepingPath)
  expect(bookkeepingFailure._tag).toBe("Failure")
  expect(manifestAfterBookkeepingFailure).toBe(before)
  expect(initialAfterBookkeepingFailure).toBe(initialBytes)
  expect(bookkeepingArtifactExists).toBe(true)

  const historyAfterBookkeepingFailure = yield* SqliteMigrations.load(manifest)
  expect(historyAfterBookkeepingFailure).toHaveLength(2)

  const command = SqliteMigrations.command({
    name: "schema",
    tables: [targetResource.table],
    manifest: manifestOption,
  })

  const commandRun = Command.runWith(command, { version: "test", renderErrors: false })
  const requiredGeneration = commandRun(["generate", "required"])
  const blocked = yield* Effect.exit(requiredGeneration)
  const manifestAfterBlockedGeneration = readFileSync(manifest, "utf8")
  const requiredPath = join(directory.path, "003_required.json")
  const requiredArtifactExists = existsSync(requiredPath)
  expect(blocked._tag).toBe("Failure")
  expect(manifestAfterBlockedGeneration).toBe(before)
  expect(requiredArtifactExists).toBe(false)

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
  const seedPath = join(directory.path, "seed.json")
  const finalPath = join(directory.path, "final.json")
  const seedText = JSON.stringify(encodedRepeat, null, 2)
  const finalText = JSON.stringify(encodedFinal, null, 2)
  writeFileSync(seedPath, seedText)
  writeFileSync(finalPath, finalText)

  const duplicateManifest = JSON.stringify({ migrations: ["001_initial.json", "seed.json", "final.json"] }, null, 2)

  writeFileSync(manifest, duplicateManifest)

  const duplicateBefore = readFileSync(manifest, "utf8")

  const duplicateId = SqliteMigrations.command({
    name: "schema",
    tables: [initialResource.table],
    manifest: manifestOption,
  })

  const duplicateRun = Command.runWith(duplicateId, { version: "test", renderErrors: false })
  const duplicateGeneration = duplicateRun(["generate", "repeat"])
  const duplicateIdFailure = yield* Effect.exit(duplicateGeneration)
  const manifestAfterDuplicateFailure = readFileSync(manifest, "utf8")
  const repeatPath = join(directory.path, "002_repeat.json")
  const repeatArtifactExists = existsSync(repeatPath)
  expect(duplicateIdFailure._tag).toBe("Failure")
  expect(manifestAfterDuplicateFailure).toBe(duplicateBefore)
  expect(repeatArtifactExists).toBe(false)
})

it.effect("generate leaves the manifest unchanged for blocked and duplicate histories", () => pipe(generatedHistoryIsNeverRegisteredOnFailure(), Effect.provide(BunServices.layer)))
