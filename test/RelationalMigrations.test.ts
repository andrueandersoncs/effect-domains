import { expect, it } from "@effect/vitest"
import { Effect, Function, Schema, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Table } from "effect-domains/table"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"

import { makeMigrationStore, SqliteMigrations } from "effect-domains/sqlite-migrations"

const sqlite = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })

const relationalLifecycle = Effect.fn("SqliteMigrations.relationalLifecycle")(function* () {
  const sql = yield* SqlClient.SqlClient
  const RelationalParentSchema = Schema.Struct({ code: Schema.String })
  interface RelationalParent extends Schema.Schema.Type<typeof RelationalParentSchema> {}
  const ChildSchema = Schema.Struct({ parentId: Schema.String, label: Schema.String })
  interface Child extends Schema.Schema.Type<typeof ChildSchema> {}
  const sourceParent = Table.make({ name: "relational_parents", schema: RelationalParentSchema })
  const sourceChild = Table.make({ name: "relational_children", schema: ChildSchema })

  const constrainedParent = Table.make({
    name: "relational_parents",
    schema: RelationalParentSchema,
    relations: { unique: [{ name: "relational_parent_code", fields: ["code"] }] },
  })

  const constrainedChild = Table.make({
    name: "relational_children",
    schema: ChildSchema,
    relations: {
      foreignKeys: [{
        name: "relational_child_parent",
        fields: ["parentId"],
        references: { table: "relational_parents", fields: ["id"] },
      }],
    },
  })

  const indexedChild = Table.make({
    name: "relational_children",
    schema: ChildSchema,
    relations: {
      foreignKeys: [{
        name: "relational_child_parent",
        fields: ["parentId"],
        references: { table: "relational_parents", fields: ["id"] },
      }],
      indexes: [{ name: "relational_child_parent_idx", fields: ["parentId"] }],
    },
  })

  const source = SqliteMigrations.snapshot([sourceParent, sourceChild])
  const constrained = SqliteMigrations.snapshot([constrainedParent, constrainedChild])
  const indexed = SqliteMigrations.snapshot([constrainedParent, indexedChild])
  const initial = SqliteMigrations.initial({ id: "relational_001", tables: [sourceParent, sourceChild] })

  const addConstraintsSteps = [
    SqliteMigrations.steps.RebuildTable.make({ table: constrainedParent.name, copies: [
    ] }),
    SqliteMigrations.steps.RebuildTable.make({ table: constrainedChild.name, copies: [
    ] }),
  ]

  const addConstraints = SqliteMigrations.make({ id: "relational_002", to: constrained,
  steps: addConstraintsSteps, })

  const addIndexSteps = [SqliteMigrations.steps.CreateIndex.make({ table: "relational_children", name: "relational_child_parent_idx" })]

  const addIndex = SqliteMigrations.make({ id: "relational_003", to: indexed,
  steps: addIndexSteps, })

  const dropIndexSteps = [SqliteMigrations.steps.DropIndex.make({ name: "relational_child_parent_idx" })]

  const dropIndex = SqliteMigrations.make({ id: "relational_004", to: constrained,
  steps: dropIndexSteps, })

  yield* makeMigrationStore(sql, [initial]).prepare(source.tables)
  yield* sql`INSERT INTO relational_parents (id, code) VALUES ('parent-1', 'one')`
  yield* sql`INSERT INTO relational_children (id, parentId, label) VALUES ('child-1', 'parent-1', 'kept')`
  yield* sql`INSERT INTO relational_children (id, parentId, label) VALUES ('child-invalid', 'missing', 'invalid')`

  const invalidMigration = yield* pipe(makeMigrationStore(sql, [initial, addConstraints]).prepare(constrained.tables), Effect.result)

  expect(invalidMigration._tag).toBe("Failure")

  const sourceChildren = yield* sql`SELECT id FROM relational_children ORDER BY id`
  expect(sourceChildren).toEqual([{ id: "child-1" }, { id: "child-invalid" }])
  yield* sql`DELETE FROM relational_children WHERE id = 'child-invalid'`

  const constrainedStore = makeMigrationStore(sql, [initial, addConstraints])
  yield* constrainedStore.prepare(constrained.tables)
  yield* constrainedStore.prepare(constrained.tables)
  const preserved = yield* sql`SELECT id, parentId, label FROM relational_children`
  expect(preserved).toEqual([{ id: "child-1", parentId: "parent-1", label: "kept" }])

  const rejectedForeignKey = yield* pipe(sql`INSERT INTO relational_children (id, parentId, label) VALUES ('child-rejected', 'missing', 'rejected')`, Effect.result)

  expect(rejectedForeignKey._tag).toBe("Failure")

  const indexedStore = makeMigrationStore(sql, [initial, addConstraints, addIndex])
  yield* indexedStore.prepare(indexed.tables)
  const indexedRows = yield* sql`SELECT id FROM relational_children`
  expect(indexedRows).toEqual([{ id: "child-1" }])

  yield* sql`DROP INDEX relational_child_parent_idx`
  yield* sql`CREATE INDEX relational_child_parent_idx ON relational_children (label)`
  const forgedIndex = yield* pipe(indexedStore.prepare(indexed.tables), Effect.result)
  expect(forgedIndex._tag).toBe("Failure")
  yield* sql`DROP INDEX relational_child_parent_idx`
  yield* sql`CREATE INDEX "relational_child_parent_idx" ON "relational_children" ("parentId")`
  const droppedStore = makeMigrationStore(sql, [initial, addConstraints, addIndex, dropIndex])
  yield* droppedStore.prepare(constrained.tables)
  yield* droppedStore.prepare(constrained.tables)
  const indexes = yield* sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'relational_child_parent_idx'`
  expect(indexes).toEqual([])
})

it.effect(
  "relational migrations rebuild safely, reject invalid data, and detect forged indexes",
  pipe(relationalLifecycle(), Effect.provide(sqlite), Function.constant),
)

const referencedParentRebuild = Effect.fn("SqliteMigrations.referencedParentRebuild")(function* () {
  const sql = yield* SqlClient.SqlClient
  const RelationalParentSchema = Schema.Struct({ code: Schema.String })
  interface RelationalParent extends Schema.Schema.Type<typeof RelationalParentSchema> {}
  const ChildSchema = Schema.Struct({ parentId: Schema.String })
  interface Child extends Schema.Schema.Type<typeof ChildSchema> {}
  const sourceParent = Table.make({ name: "rebuild_parents", schema: RelationalParentSchema })

  const sourceChild = Table.make({
    name: "rebuild_children",
    schema: ChildSchema,
    relations: {
      foreignKeys: [{
        name: "rebuild_child_parent",
        fields: ["parentId"],
        references: { table: "rebuild_parents", fields: ["id"] },
      }],
    },
  })

  const targetParent = Table.make({
    name: "rebuild_parents",
    schema: RelationalParentSchema,
    relations: { unique: [{ name: "rebuild_parent_code", fields: ["code"] }] },
  })

  const source = SqliteMigrations.snapshot([sourceParent, sourceChild])
  const target = SqliteMigrations.snapshot([targetParent, sourceChild])
  const initial = SqliteMigrations.initial({ id: "rebuild_001", tables: [sourceParent, sourceChild] })

  const rebuildSteps = [SqliteMigrations.steps.RebuildTable.make({ table: targetParent.name, copies: [
  ] })]

  const rebuild = SqliteMigrations.make({ id: "rebuild_002", to: target,
  steps: rebuildSteps, })

  yield* makeMigrationStore(sql, [initial]).prepare(source.tables)
  yield* sql`INSERT INTO rebuild_parents (id, code) VALUES ('rebuild-parent', 'one')`
  yield* sql`INSERT INTO rebuild_children (id, parentId) VALUES ('rebuild-child', 'rebuild-parent')`
  const store = makeMigrationStore(sql, [initial, rebuild])
  yield* store.prepare(target.tables)
  yield* store.prepare(target.tables)
  const children = yield* sql`SELECT id, parentId FROM rebuild_children`
  expect(children).toEqual([{ id: "rebuild-child", parentId: "rebuild-parent" }])
})

it.effect(
  "rebuilds a referenced parent without dropping child rows",
  pipe(referencedParentRebuild(), Effect.provide(sqlite), Function.constant),
)

const initialIndexes = Effect.fn("SqliteMigrations.initialIndexes")(function* () {
  const sql = yield* SqlClient.SqlClient
  const IndexedSchema = Schema.Struct({ label: Schema.String })
  interface Indexed extends Schema.Schema.Type<typeof IndexedSchema> {}

  const table = Table.make({
    name: "initial_indexes", schema: IndexedSchema,
    relations: { indexes: [{ name: "initial_label_idx", fields: ["label"] }] },
  })

  const initial = SqliteMigrations.initial({ id: "001", tables: [table] })

  expect(initial.steps).toMatchObject([
    { _tag: "SqliteCreateTable", table: "initial_indexes" },
    { _tag: "SqliteCreateIndex", table: "initial_indexes", name: "initial_label_idx" },
  ])

  const store = makeMigrationStore(sql, [initial])
  yield* store.prepare(initial.to.tables)
  yield* store.prepare(initial.to.tables)
  yield* sql`INSERT INTO initial_indexes (id, label) VALUES ('indexed', 'kept')`
  const rows = yield* sql`SELECT id FROM initial_indexes INDEXED BY initial_label_idx WHERE label = 'kept'`
  expect(rows).toEqual([{ id: "indexed" }])
})

it.effect("initial derives table and index instructions from an empty snapshot", () => pipe(initialIndexes(), Effect.provide(sqlite)))
