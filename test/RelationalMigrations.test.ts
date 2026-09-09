import { expect, it } from "@effect/vitest"
import { Effect, Function, Schema, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Table } from "effect-domains/table"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { makeMigrationStore, SqliteMigrations } from "effect-domains/sqlite-migrations"
const sqlite = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })

const relationalLifecycle = Effect.fn("SqliteMigrations.relationalLifecycle")(function* () {
  const sql = yield* SqlClient.SqlClient
  const ParentSchema = Schema.Struct({ code: Schema.String })
  interface Parent extends Schema.Schema.Type<typeof ParentSchema> {}
  const ChildSchema = Schema.Struct({ parentId: Schema.String, label: Schema.String })
  interface Child extends Schema.Schema.Type<typeof ChildSchema> {}
  const sourceParent = Table.make({ name: "relational_parents", schema: ParentSchema })
  const sourceChild = Table.make({ name: "relational_children", schema: ChildSchema })

  const constrainedParent = Table.make({
    name: "relational_parents",
    schema: ParentSchema,
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

  const empty = SqliteMigrations.snapshot([])
  const source = SqliteMigrations.snapshot([sourceParent, sourceChild])
  const constrained = SqliteMigrations.snapshot([constrainedParent, constrainedChild])
  const indexed = SqliteMigrations.snapshot([constrainedParent, indexedChild])
  const initial = SqliteMigrations.plan({ id: "relational_001", from: empty, to: source })

  const addConstraints = SqliteMigrations.plan({
    id: "relational_002",
    from: source,
    to: constrained,
  })

  const addIndex = SqliteMigrations.plan({
    id: "relational_003",
    from: constrained,
    to: indexed,
  })

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
})

it.effect(
  "relational migrations rebuild safely, reject invalid data, and detect forged indexes",
  pipe(relationalLifecycle(), Effect.provide(sqlite), Function.constant),
)

const referencedParentRebuild = Effect.fn("SqliteMigrations.referencedParentRebuild")(function* () {
  const sql = yield* SqlClient.SqlClient
  const ParentSchema = Schema.Struct({ code: Schema.String })
  interface Parent extends Schema.Schema.Type<typeof ParentSchema> {}
  const ChildSchema = Schema.Struct({ parentId: Schema.String })
  interface Child extends Schema.Schema.Type<typeof ChildSchema> {}
  const sourceParent = Table.make({ name: "rebuild_parents", schema: ParentSchema })


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
    schema: ParentSchema,
    relations: { unique: [{ name: "rebuild_parent_code", fields: ["code"] }] },
  })


  const empty = SqliteMigrations.snapshot([])
  const source = SqliteMigrations.snapshot([sourceParent, sourceChild])
  const target = SqliteMigrations.snapshot([targetParent, sourceChild])
  const initial = SqliteMigrations.plan({ id: "rebuild_001", from: empty, to: source })
  const rebuild = SqliteMigrations.plan({ id: "rebuild_002", from: source, to: target })

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
