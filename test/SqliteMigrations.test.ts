import { Authorization } from "effect-domains/authorization"
import { expect, it } from "@effect/vitest"
import { Array, Effect, Equivalence, Function, Option, pipe, Result, Schema } from "effect"
import { Table, TableField, TableSnapshot } from "effect-domains/table"
import { renderCreateTable } from "../packages/effect-domains/src/sqlite-ddl.ts"
import { SqlClient } from "effect/unstable/sql"
import { Resource } from "effect-domains/resource"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"

import { makeMigrationStore, SqliteMigrations, SqliteMigration } from "effect-domains/sqlite-migrations"

const empty = SqliteMigrations.snapshot([])
const sqliteClient = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })
const SqliteMigrationJsonSchema = Schema.toCodecJson(SqliteMigration)
const encodeMigration = Schema.encodeUnknownSync(SqliteMigrationJsonSchema)
const TitleSchema = Schema.Struct({ title: Schema.NonEmptyString })

const nullableAdditionsAndRenamesAction = Effect.fn("SqliteMigrations.nullableAdditionsAndRenames")(function* () {
  const database = yield* SqlClient.SqlClient
  const before = Resource.define({ authorization: Authorization.public, name: "documents", schema: TitleSchema, capabilities: Resource.capabilities() })
  const NullableCommentSchema = Schema.NullOr(Schema.String)

  const NullableDocumentSchema = Schema.Struct({
    comment: NullableCommentSchema,
    ...before.schema.fields,
  })

  interface NullableDocument extends Schema.Schema.Type<typeof NullableDocumentSchema> {}
  const nullable = Resource.define({ authorization: Authorization.public, name: "documents", schema: NullableDocumentSchema, capabilities: Resource.capabilities() })
  const isNonNegative = Schema.isGreaterThanOrEqualTo(0)
  const NonNegativeIntSchema = Schema.Int.check(isNonNegative)

  const RenamedDocumentSchema = Schema.Struct({
    comment: nullable.schema.fields.comment,
    heading: before.schema.fields.title,
    priority: NonNegativeIntSchema,
  })

  interface RenamedDocument extends Schema.Schema.Type<typeof RenamedDocumentSchema> {}
  const renamed = Resource.define({ authorization: Authorization.public, name: "documents", schema: RenamedDocumentSchema, capabilities: Resource.capabilities() })
  const source = SqliteMigrations.snapshot([Resource.table(before)])
  const withComment = SqliteMigrations.snapshot([Resource.table(nullable)])
  const target = SqliteMigrations.snapshot([Resource.table(renamed)])
  const initial = SqliteMigrations.initial({ id: "001", tables: [Resource.table(before)] })
  const nullableTable = Table.snapshot(Resource.table(nullable))
  const isComment = (field: TableField) => Equivalence.strictEqual<string>()(field.name, "comment")
  const comment = pipe(nullableTable.fields, Array.findFirst(isComment), Option.getOrThrow)
  const additionSteps = [SqliteMigrations.steps.AddColumn.make({ table: "documents", column: comment })]

  const addition = SqliteMigrations.make({ id: "002", to: withComment,
  steps: additionSteps, })

  const HeadingSchema = Schema.Struct({ heading: Schema.NonEmptyString, comment: NullableCommentSchema })
  interface Heading extends Schema.Schema.Type<typeof HeadingSchema> {}
  const heading = Table.make({ name: "documents", schema: HeadingSchema })
  const withHeading = SqliteMigrations.snapshot([heading])
  const renameSteps = [SqliteMigrations.steps.RenameColumn.make({ table: "documents", from: "title", to: "heading" })]

  const rename = SqliteMigrations.make({ id: "003", to: withHeading,
  steps: renameSteps, })

  const changeSteps = [SqliteMigrations.steps.RebuildTable.make({ table: Resource.table(renamed).name, copies: [
    SqliteMigrations.copies.Value.make({ column: "priority", value: 0 }),
  ] })]

  const change = SqliteMigrations.make({ id: "004", to: target,
  steps: changeSteps, })

  const initialStore = makeMigrationStore(database, [initial])
  yield* initialStore.prepare(source.tables)
  const document = yield* Resource.repository(before).create({ title: "preserve me" })
  const additionStore = makeMigrationStore(database, [initial, addition])
  yield* additionStore.prepare(withComment.tables)
  const nullableDocument = yield* Resource.repository(nullable).get(document.id)
  const store = makeMigrationStore(database, [initial, addition, rename, change])
  yield* store.prepare(target.tables)
  yield* store.prepare(target.tables)
  const renamedDocument = yield* Resource.repository(renamed).get(document.id)

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

  const source = Resource.define({ authorization: Authorization.public,
  name: "rename_chain",
  schema: ChainSourceSchema, capabilities: Resource.capabilities(),  })

  const target = Resource.define({ authorization: Authorization.public,
  name: "rename_chain",
  schema: ChainTargetSchema, capabilities: Resource.capabilities(),  })

  const sourceSnapshot = SqliteMigrations.snapshot([Resource.table(source)])
  const targetSnapshot = SqliteMigrations.snapshot([Resource.table(target)])
  const initial = SqliteMigrations.initial({ id: "001_rename_chain", tables: [Resource.table(source)] })

  const chainSteps = [SqliteMigrations.steps.RebuildTable.make({ table: Resource.table(target).name, copies: [
    SqliteMigrations.copies.Source.make({ column: "b", source: "a" }),
    SqliteMigrations.copies.Source.make({ column: "c", source: "b" }),
  ] })]

  const chain = SqliteMigrations.make({ id: "002_rename_chain", to: targetSnapshot,
  steps: chainSteps, })

  const initialStore = makeMigrationStore(database, [initial])

  yield* initialStore.prepare(sourceSnapshot.tables)
  const sourceRecord = yield* Resource.repository(source).create({ a: "original a", b: "original b" })
  const chainedStore = makeMigrationStore(database, [initial, chain])

  yield* chainedStore.prepare(targetSnapshot.tables)
  const chainedRecord = yield* Resource.repository(target).get(sourceRecord.id)

  expect(chainedRecord).toEqual({ id: sourceRecord.id, b: sourceRecord.a, c: sourceRecord.b })

  const CycleSchema = Schema.Struct({ a: Schema.String, b: Schema.String })
  interface Cycle extends Schema.Schema.Type<typeof CycleSchema> {}

  const cycle = Resource.define({ authorization: Authorization.public,
  name: "rename_cycle",
  schema: CycleSchema, capabilities: Resource.capabilities(),  })

  const cycleSnapshot = SqliteMigrations.snapshot([Resource.table(target), Resource.table(cycle)])
  const addCycleSteps = [SqliteMigrations.steps.CreateTable.make({ table: Resource.table(cycle).name })]

  const addCycle = SqliteMigrations.make({ id: "003_rename_cycle", to: cycleSnapshot,
  steps: addCycleSteps, })

  const swapSteps = [SqliteMigrations.steps.RebuildTable.make({ table: Resource.table(cycle).name, copies: [
    SqliteMigrations.copies.Source.make({ column: "a", source: "b" }),
    SqliteMigrations.copies.Source.make({ column: "b", source: "a" }),
  ] })]

  const swap = SqliteMigrations.make({ id: "004_rename_cycle", to: cycleSnapshot,
  steps: swapSteps, })

  const cycleStore = makeMigrationStore(database, [initial, chain, addCycle])

  yield* cycleStore.prepare(cycleSnapshot.tables)
  const cycleRecord = yield* Resource.repository(cycle).create({ a: "left", b: "right" })
  const swappedStore = makeMigrationStore(database, [initial, chain, addCycle, swap])

  yield* swappedStore.prepare(cycleSnapshot.tables)
  const swappedRecord = yield* Resource.repository(cycle).get(cycleRecord.id)

  expect(swappedRecord).toEqual({ id: cycleRecord.id, a: cycleRecord.b, b: cycleRecord.a })
})()

const interactingRenames = pipe(interactingRenamesAction, Effect.provide(sqliteClient))
const interactingRenamesTest = Function.constant(interactingRenames)

it.effect("interacting column renames rebuild from original source values", interactingRenamesTest)

const nullableIdentifierSnapshotsAction = Effect.fn("SqliteMigrations.nullableIdentifierSnapshots")(function* () {
  const resource = Resource.define({ authorization: Authorization.public,
  name: "nullable_history_identifier",
  schema: TitleSchema, capabilities: Resource.capabilities(),  })

  const initial = SqliteMigrations.initial({ id: "nullable_identifier", tables: [Resource.table(resource)] })

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

  const makeInvalid = () => SqliteMigrations.make({ ...nullableArtifact })
  expect(makeInvalid).toThrow()
})()

it.effect("nullable identifiers fail history decoding and synchronous construction", Function.constant(nullableIdentifierSnapshotsAction))

const explicitExpressions = Effect.fn("SqliteMigrations.explicitExpressions")(function* () {
  const database = yield* SqlClient.SqlClient
  const source = Resource.define({ authorization: Authorization.public, name: "expressions", schema: TitleSchema, capabilities: Resource.capabilities() })
  const TargetSchema = Schema.Struct({ title: Schema.String, label: Schema.String, priority: Schema.Int })
  interface Target extends Schema.Schema.Type<typeof TargetSchema> {}
  const target = Resource.define({ authorization: Authorization.public, name: "expressions", schema: TargetSchema, capabilities: Resource.capabilities() })
  const from = SqliteMigrations.snapshot([Resource.table(source)])
  const to = SqliteMigrations.snapshot([Resource.table(target)])
  const initial = SqliteMigrations.initial({ id: "001", tables: [Resource.table(source)] })

  const migrationSteps = [SqliteMigrations.steps.RebuildTable.make({ table: Resource.table(target).name, copies: [
    SqliteMigrations.copies.Expression.make({ column: "title", expression: `replace("title", ':', '-')` }),
    SqliteMigrations.copies.Value.make({ column: "label", value: "json:colon' ); DROP TABLE expressions; --" }),
    SqliteMigrations.copies.Value.make({ column: "priority", value: 0 }),
  ] })]

  const migration = SqliteMigrations.make({ id: "002", to, steps: migrationSteps })

  yield* makeMigrationStore(database, [initial]).prepare(from.tables)
  const record = yield* Resource.repository(source).create({ title: "before:after" })
  const encodedInitial = encodeMigration(initial)
  const encodedMigration = encodeMigration(migration)
  const history = yield* SqliteMigrations.decodeHistory([encodedInitial, encodedMigration])
  yield* makeMigrationStore(database, history).prepare(to.tables)
  const transformed = yield* Resource.repository(target).get(record.id)
  expect(transformed).toEqual({ id: record.id, title: "before-after", label: "json:colon' ); DROP TABLE expressions; --", priority: 0 })
})

it.effect("explicit rebuild expressions and backfills survive JSON round trips and preserve colons", () => pipe(explicitExpressions(), Effect.provide(sqliteClient)))

const driftDetectionAction = Effect.fn("SqliteMigrations.driftDetection")(function* () {
  const database = yield* SqlClient.SqlClient
  const OriginalLabelSchema = Schema.Literal("two  spaces")
  const OriginalSchema = Schema.Struct({ label: OriginalLabelSchema })
  interface Original extends Schema.Schema.Type<typeof OriginalSchema> {}
  const original = Resource.define({ authorization: Authorization.public, name: "labels", schema: OriginalSchema, capabilities: Resource.capabilities() })
  const ChangedLabelSchema = Schema.Literal("two spaces")
  const ChangedSchema = Schema.Struct({ label: ChangedLabelSchema })
  interface Changed extends Schema.Schema.Type<typeof ChangedSchema> {}
  const changed = Resource.define({ authorization: Authorization.public, name: "labels", schema: ChangedSchema, capabilities: Resource.capabilities() })
  const source = SqliteMigrations.snapshot([Resource.table(original)])
  const initial = SqliteMigrations.initial({ id: "001_drift", tables: [Resource.table(original)] })
  const store = makeMigrationStore(database, [initial])
  yield* store.prepare(source.tables)
  yield* database`DROP TABLE labels`
  const changedSnapshot = Table.snapshot(Resource.table(changed))
  const changedTableSql = renderCreateTable(changedSnapshot)
  const changedTable = database.literal(changedTableSql)
  yield* pipe(database`${changedTable}`, Effect.asVoid)
  const record = yield* Resource.repository(changed).create({ label: "two spaces" })
  const prepareSource = store.prepare(source.tables)
  const outcome = yield* Effect.result(prepareSource)
  const loadedRecord = yield* Resource.repository(changed).get(record.id)

  expect(outcome).toMatchObject({ _tag: "Failure", failure: { _tag: "MigrationError" } })
  expect(loadedRecord).toEqual(record)
})()

const driftDetection = pipe(driftDetectionAction, Effect.provide(sqliteClient))
const driftDetectionTest = Function.constant(driftDetection)

it.effect("drift detection preserves whitespace inside SQL constraint literals", driftDetectionTest)

const missingInitialHistoryAction = Effect.fn("SqliteMigrations.missingInitialHistory")(function* () {
  const database = yield* SqlClient.SqlClient
  const resource = Resource.define({ authorization: Authorization.public, name: "requires_initial_history", schema: TitleSchema, capabilities: Resource.capabilities() })
  const target = SqliteMigrations.snapshot([Resource.table(resource)])
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
  const before = Resource.define({ authorization: Authorization.public, name: "jobs", schema: TitleSchema, capabilities: Resource.capabilities() })
  const isPositive = Schema.isGreaterThan(0)
  const PositiveIntSchema = Schema.Int.check(isPositive)

  const JobSchema = Schema.Struct({
    ...before.schema.fields,
    priority: PositiveIntSchema,
  })

  interface Job extends Schema.Schema.Type<typeof JobSchema> {}
  const after = Resource.define({ authorization: Authorization.public, name: "jobs", schema: JobSchema, capabilities: Resource.capabilities() })
  const source = SqliteMigrations.snapshot([Resource.table(before)])
  const target = SqliteMigrations.snapshot([Resource.table(after)])
  const initial = SqliteMigrations.initial({ id: "001", tables: [Resource.table(before)] })

  const invalidSteps = [SqliteMigrations.steps.RebuildTable.make({ table: Resource.table(after).name, copies: [
    SqliteMigrations.copies.Expression.make({ column: "priority", expression: "-1" }),
  ] })]

  const invalid = SqliteMigrations.make({ id: "002", to: target,
  steps: invalidSteps, })

  const initialStore = makeMigrationStore(database, [initial])
  yield* initialStore.prepare(source.tables)
  const job = yield* Resource.repository(before).create({ title: "keep me" })
  const failedStore = makeMigrationStore(database, [initial, invalid])
  const failedPrepare = failedStore.prepare(target.tables)
  const outcome = yield* Effect.result(failedPrepare)
  const failed = Result.isFailure(outcome)
  const rollbackStore = makeMigrationStore(database, [initial])
  yield* rollbackStore.prepare(source.tables)
  const restoredJob = yield* Resource.repository(before).get(job.id)

  expect(failed).toBe(true)
  expect(restoredJob).toEqual(job)

  const correctedSteps = [SqliteMigrations.steps.RebuildTable.make({ table: Resource.table(after).name, copies: [
    SqliteMigrations.copies.Value.make({ column: "priority", value: 1 }),
  ] })]

  const corrected = SqliteMigrations.make({ id: "002", to: target,
  steps: correctedSteps, })

  const correctedStore = makeMigrationStore(database, [initial, corrected])
  yield* correctedStore.prepare(target.tables)
  const migratedJob = yield* Resource.repository(after).get(job.id)

  expect(migratedJob).toEqual({ ...job, priority: 1 })
})()

const failedTransformsRollBack = pipe(failedTransformsRollBackAction, Effect.provide(sqliteClient))
const failedTransformsRollBackTest = Function.constant(failedTransformsRollBack)

it.effect("failed transforms roll back table data and migration history before a corrected retry", failedTransformsRollBackTest)

const decodedHistoryValidation = Effect.fn("SqliteMigrations.decodedHistoryValidation")(function* () {
  const table = Table.make({ name: "imported_history", schema: TitleSchema })
  const initial = SqliteMigrations.initial({ id: "001_initial", tables: [table] })
  const encoded = encodeMigration(initial)
  const history = yield* SqliteMigrations.decodeHistory([encoded])
  expect(history).toEqual([initial])
  const loaded = pipe(history, Array.head, Option.getOrThrow)
  const loadedTable = pipe(loaded.to.tables, Array.head, Option.getOrThrow)

  const frozen = [
    Object.isFrozen(initial), Object.isFrozen(initial.steps), Object.isFrozen(initial.to.tables),
    Object.isFrozen(history), Object.isFrozen(loaded), Object.isFrozen(loadedTable.fields),
  ]

  expect(frozen).toEqual([true, true, true, true, true, true])
  const malformed = yield* pipe(SqliteMigrations.decodeHistory([{ id: 42 }]), Effect.result)
  expect(malformed).toMatchObject({ _tag: "Failure", failure: { _tag: "MigrationError" } })
})

it.effect("imported history validates artifacts and freezes nested snapshots", decodedHistoryValidation)

const invalidHistories = Effect.fn("SqliteMigrations.invalidHistories")(function* () {
  const table = Table.make({ name: "invalid_history", schema: TitleSchema })
  const initial = SqliteMigrations.initial({ id: "001", tables: [table] })
  const encodedInitial = encodeMigration(initial)
  const duplicate = SqliteMigration.make({ ...initial, steps: [] })
  const blank = SqliteMigration.make({ ...initial, id: "" })

  const disconnected = SqliteMigration.make({
    id: "002",
    to: empty,
    steps: [SqliteMigrations.steps.CreateTable.make({ table: "invalid_history" })],
  })

  const invalid = [
    [encodedInitial, encodeMigration(duplicate)],
    [encodeMigration(blank)],
    [encodedInitial, encodeMigration(disconnected)],
  ]

  const rejectHistory = Effect.fn("SqliteMigrations.rejectHistory")(function* (history: unknown) {
    const outcome = yield* pipe(SqliteMigrations.decodeHistory(history), Effect.result)
    expect(outcome).toMatchObject({ _tag: "Failure", failure: { _tag: "MigrationError" } })
  })

  yield* Effect.forEach(invalid, rejectHistory)
  expect(() => SqliteMigrations.history(initial, disconnected)).toThrow()
})

it.effect("history rejects empty or duplicate ids and target-incoherent chaining", invalidHistories)

it.effect("history requires explicit copies for newly introduced rebuild columns", () =>
  Effect.sync(() => {
    const before = Table.make({ name: "new_copy_column", schema: TitleSchema })
    const TargetSchema = Schema.Struct({ title: Schema.NonEmptyString, priority: Schema.Int })
    interface Target extends Schema.Schema.Type<typeof TargetSchema> {}
    const after = Table.make({ name: "new_copy_column", schema: TargetSchema })
    const initial = SqliteMigrations.initial({ id: "001", tables: [before] })
    const target = SqliteMigrations.snapshot([after])
    const rebuild = SqliteMigrations.steps.RebuildTable.make({ table: after.name, copies: [] })

    const migration = SqliteMigrations.make({
      id: "002",
      to: target,
      steps: [rebuild],
    })

    expect(() => SqliteMigrations.history(initial, migration)).toThrow()
  }))

const tamperedHistory = Effect.fn("SqliteMigrations.tamperedHistory")(function* () {
  const database = yield* SqlClient.SqlClient
  const resource = Resource.define({ authorization: Authorization.public, name: "tampered_history", schema: TitleSchema, capabilities: Resource.capabilities() })
  const target = SqliteMigrations.snapshot([Resource.table(resource)])
  const initial = SqliteMigrations.initial({ id: "001", tables: [Resource.table(resource)] })
  const second = SqliteMigrations.make({ id: "002", to: target, steps: [] })
  const third = SqliteMigrations.make({ id: "003", to: target, steps: [] })
  const store = makeMigrationStore(database, [initial, second, third])
  yield* store.prepare(target.tables)
  const record = yield* Resource.repository(resource).create({ title: "preserved" })
  const changed = SqliteMigrations.make({ ...initial, steps: [] })
  const changedStore = makeMigrationStore(database, [changed, second, third])
  const changedArtifact = yield* pipe(changedStore.prepare(target.tables), Effect.result)
  expect(changedArtifact).toMatchObject({ _tag: "Failure", failure: { _tag: "MigrationError" } })

  yield* database`UPDATE _effect_schema_migrations SET artifact = '{}' WHERE id = '003'`
  const forgedLedger = yield* pipe(store.prepare(target.tables), Effect.result)
  expect(forgedLedger).toMatchObject({ _tag: "Failure", failure: { _tag: "MigrationError" } })
  yield* database`DELETE FROM _effect_schema_migrations WHERE id = '003'`
  yield* store.prepare(target.tables)
  yield* database`DELETE FROM _effect_schema_migrations WHERE id = '002'`
  const gap = yield* pipe(store.prepare(target.tables), Effect.result)
  expect(gap).toMatchObject({ _tag: "Failure", failure: { _tag: "MigrationError" } })
  const preserved = yield* Resource.repository(resource).get(record.id)
  expect(preserved).toEqual(record)
})

it.effect("changed artifacts, forged ledger entries and history gaps fail without changing records", () => pipe(tamperedHistory(), Effect.provide(sqliteClient)))

const untrackedObjects = Effect.fn("SqliteMigrations.untrackedObjects")(function* () {
  const database = yield* SqlClient.SqlClient
  const resource = Resource.define({ authorization: Authorization.public, name: "untracked_objects", schema: TitleSchema, capabilities: Resource.capabilities() })
  const target = SqliteMigrations.snapshot([Resource.table(resource)])
  const initial = SqliteMigrations.initial({ id: "001", tables: [Resource.table(resource)] })
  const store = makeMigrationStore(database, [initial])
  yield* store.prepare(target.tables)
  const record = yield* Resource.repository(resource).create({ title: "preserved" })
  yield* database`CREATE INDEX untracked_title ON untracked_objects (title)`
  const index = yield* pipe(store.prepare(target.tables), Effect.result)
  expect(index).toMatchObject({ _tag: "Failure", failure: { _tag: "MigrationError" } })
  yield* database`DROP INDEX untracked_title`
  yield* database`CREATE TRIGGER untracked_trigger AFTER INSERT ON untracked_objects BEGIN SELECT 1; END`
  const trigger = yield* pipe(store.prepare(target.tables), Effect.result)
  expect(trigger).toMatchObject({ _tag: "Failure", failure: { _tag: "MigrationError" } })
  yield* database`DROP TRIGGER untracked_trigger`
  yield* store.prepare(target.tables)
  const preserved = yield* Resource.repository(resource).get(record.id)
  expect(preserved).toEqual(record)
})

it.effect("untracked indexes and triggers are rejected as drift without changing records", () => pipe(untrackedObjects(), Effect.provide(sqliteClient)))

const catalogIdentity = Effect.fn("SqliteMigrations.catalogIdentity")(function* () {
  const database = yield* SqlClient.SqlClient

  const resource = Resource.define({ authorization: Authorization.public,
  name: "catalog_identity",
  schema: TitleSchema, capabilities: Resource.capabilities(), relations: { indexes: [{ name: "catalog_title", fields: ["title"] }] }, })

  const initial = SqliteMigrations.initial({ id: "001", tables: [Resource.table(resource)] })
  const store = makeMigrationStore(database, [initial])
  const target = SqliteMigrations.snapshot([Resource.table(resource)])
  yield* store.prepare(target.tables)
  const record = yield* Resource.repository(resource).create({ title: "preserved" })
  yield* database`DROP INDEX catalog_title`
  const missing = yield* pipe(store.prepare(target.tables), Effect.result)
  expect(missing).toMatchObject({ _tag: "Failure", failure: { _tag: "MigrationError" } })
  yield* database`CREATE TRIGGER catalog_title AFTER INSERT ON catalog_identity BEGIN SELECT 1; END`
  const replaced = yield* pipe(store.prepare(target.tables), Effect.result)
  expect(replaced).toMatchObject({ _tag: "Failure", failure: { _tag: "MigrationError" } })
  yield* database`DROP TRIGGER catalog_title`
  yield* database`CREATE INDEX "catalog_title" ON "catalog_identity" ("title")`
  yield* store.prepare(target.tables)
  const preserved = yield* Resource.repository(resource).get(record.id)
  expect(preserved).toEqual(record)
})

it.effect("catalog verification rejects missing indexes and same-name triggers", () => pipe(catalogIdentity(), Effect.provide(sqliteClient)))

const dottedIdentifiers = Effect.fn("SqliteMigrations.dottedIdentifiers")(function* () {
  const database = yield* SqlClient.SqlClient
  const BeforeSchema = Schema.Struct({ "old.field": Schema.String })
  interface Before extends Schema.Schema.Type<typeof BeforeSchema> {}
  const RenamedSchema = Schema.Struct({ "new.field": Schema.String })
  interface Renamed extends Schema.Schema.Type<typeof RenamedSchema> {}
  const AddedSchema = Schema.Struct({ "new.field": Schema.String, "note.field": Schema.NullOr(Schema.String) })
  interface Added extends Schema.Schema.Type<typeof AddedSchema> {}
  const FinalSchema = Schema.Struct({ "final.field": Schema.String, "note.field": Schema.NullOr(Schema.String) })
  interface Final extends Schema.Schema.Type<typeof FinalSchema> {}
  const before = Table.make({ name: "dotted.table", schema: BeforeSchema })
  const renamed = Table.make({ name: "dotted.table", schema: RenamedSchema })
  const added = Table.make({ name: "dotted.table", schema: AddedSchema })
  const final = Table.make({ name: "dotted.table", schema: FinalSchema })

  const indexed = Table.make({
    name: "dotted.table", schema: FinalSchema,
    relations: { indexes: [{ name: "dotted.index", fields: ["final.field"] }] },
  })

  const initial = SqliteMigrations.initial({ id: "001", tables: [before] })
  const from = SqliteMigrations.snapshot([before])
  yield* makeMigrationStore(database, [initial]).prepare(from.tables)
  yield* database`INSERT INTO "dotted.table" ("id", "old.field") VALUES ('one', 'preserved')`
  const renamedSnapshot = SqliteMigrations.snapshot([renamed])
  const renameSteps = [SqliteMigrations.steps.RenameColumn.make({ table: before.name, from: "old.field", to: "new.field" })]

  const rename = SqliteMigrations.make({
    id: "002", to: renamedSnapshot,
    steps: renameSteps,
  })

  const addedSnapshot = SqliteMigrations.snapshot([added])
  const physicalAdded = Table.snapshot(added)
  const isNote = (field: TableField) => Equivalence.strictEqual<string>()(field.name, "note.field")
  const note = pipe(physicalAdded.fields, Array.findFirst(isNote), Option.getOrThrow)
  const additionSteps = [SqliteMigrations.steps.AddColumn.make({ table: added.name, column: note })]

  const addition = SqliteMigrations.make({ id: "003", to: addedSnapshot,
  steps: additionSteps, })

  const finalSnapshot = SqliteMigrations.snapshot([final])
  const finalTable = Table.snapshot(final)

  const rebuildSteps = [SqliteMigrations.steps.RebuildTable.make({
      table: final.name,
      copies: [
        SqliteMigrations.copies.Source.make({ column: "final.field", source: "new.field" }),
        SqliteMigrations.copies.Value.make({ column: "note.field", value: "copied" }),
      ],
    })]

  const rebuild = SqliteMigrations.make({ id: "004", to: finalSnapshot,
  steps: rebuildSteps, })

  const indexedSnapshot = SqliteMigrations.snapshot([indexed])
  const createIndexSteps = [SqliteMigrations.steps.CreateIndex.make({ table: final.name, name: "dotted.index" })]

  const createIndex = SqliteMigrations.make({ id: "005", to: indexedSnapshot,
  steps: createIndexSteps, })

  const dropIndexSteps = [SqliteMigrations.steps.DropIndex.make({ name: "dotted.index" })]

  const dropIndex = SqliteMigrations.make({ id: "006", to: finalSnapshot,
  steps: dropIndexSteps, })

  yield* makeMigrationStore(database, [initial, rename, addition, rebuild, createIndex, dropIndex]).prepare(finalSnapshot.tables)
  const rows = yield* database`SELECT * FROM "dotted.table"`
  expect(rows).toEqual([{ id: "one", "final.field": "preserved", "note.field": "copied" }])
})

it.effect("migration instructions quote dotted identifiers as whole names", () => pipe(dottedIdentifiers(), Effect.provide(sqliteClient)))
