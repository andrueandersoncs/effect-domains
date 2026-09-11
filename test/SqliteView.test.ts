import { expect, it } from "@effect/vitest"
import { Data, Effect, Equivalence, Layer, Record, Schema, SchemaGetter, pipe } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { SqlClient, SqlSchema } from "effect/unstable/sql"
import { Application } from "effect-domains/application"
import { Authorization } from "effect-domains/authorization"
import { identifier } from "effect-domains/domain"
import { Resource } from "effect-domains/resource"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { SqliteView } from "effect-domains/sqlite-view"
import { Table } from "effect-domains/table"
import { prepareTables } from "./prepare-tables.ts"
import { StoragePrefix, StoredTextSchema } from "./prefix-codec.ts"

const JobSchema = Schema.Struct({
  id: identifier(Schema.String), tenant: Schema.String,
  technicianId: Schema.NullOr(Schema.String), "is.urgent": Schema.Boolean,
})

const TechnicianSchema = Schema.Struct({
  id: identifier(Schema.String), tenant: Schema.String, localId: Schema.String,
  name: StoredTextSchema, onCall: Schema.NullOr(Schema.Boolean),
})

const Jobs = Table.make({ name: "jobs.work", schema: JobSchema })
const Technicians = Table.make({ name: 'people"records', schema: TechnicianSchema })
const database = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })

it.effect("decodes composite left joins without losing booleans, service codecs, or unmatched rows", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([Jobs, Technicians])
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO "jobs.work" (id, tenant, technicianId, "is.urgent") VALUES ('assigned', 'acme', 'sam', 1), ('waiting', 'acme', NULL, 0)`
    yield* sql`INSERT INTO "people""records" (id, tenant, localId, name, onCall) VALUES ('a', 'acme', 'sam', 'stored:Sam', 1), ('b', 'other', 'sam', 'stored:Not Sam', 0)`

    const view = SqliteView.make({
      tables: { "base.jobs": Jobs, 'joined"people': Technicians },
      from: "base.jobs",
      joins: [{ kind: "left", table: 'joined"people', on: [
        { left: ["base.jobs", "tenant"], right: ['joined"people', "tenant"] },
        { left: ["base.jobs", "technicianId"], right: ['joined"people', "localId"] },
      ] }],
      select: {
        id: ["base.jobs", "id"], urgent: ["base.jobs", "is.urgent"],
        'technician.name"': ['joined"people', "name"], onCall: ['joined"people', "onCall"],
      },
    })

    const query = SqlSchema.findAll({
      Request: Schema.Void,
      Result: view.schema,
      execute: () => sql<Readonly<Record<string, unknown>>>`${view.select(sql)} ORDER BY ${view.column(sql, ["base.jobs", "id"])} ASC`,
    })

    const original = yield* query(undefined)

    expect(original).toEqual([
      { id: "assigned", urgent: true, 'technician.name"': "Sam", onCall: true },
      { id: "waiting", urgent: false, 'technician.name"': null, onCall: null },
    ])

    yield* sql`UPDATE "people""records" SET name = 'stored:Samuel', onCall = NULL WHERE id = 'a'`
    const updated = yield* query(undefined)

    expect(updated).toEqual([
      { id: "assigned", urgent: true, 'technician.name"': "Samuel", onCall: null },
      { id: "waiting", urgent: false, 'technician.name"': null, onCall: null },
    ])
  }),
  Effect.provide(database),
  Effect.provideService(StoragePrefix, { value: "stored:" }),
))

it.effect("snapshots selections so caller mutation cannot redirect a compiled read", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([Jobs])
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO "jobs.work" (id, tenant, technicianId, "is.urgent") VALUES ('job', 'acme', NULL, 0)`
    const select = Record.singleton("value", ["j", "tenant"] as const)
    const view = SqliteView.make({ tables: { j: Jobs }, from: "j", joins: [], select })
    yield* Effect.sync(() => Reflect.set(select.value, "1", "id"))
    const rows = yield* sql<Readonly<Record<string, unknown>>>`${view.select(sql)}`
    const RowsSchema = Schema.Array(view.schema)
    const decoded = yield* Schema.decodeUnknownEffect(RowsSchema)(rows)
    expect(decoded).toEqual([{ value: "acme" }])
  }),
  Effect.provide(database),
))

it("rejects ambiguous or disconnected joins rather than silently changing result cardinality", () => {
  const base = new Data.Class({ tables: { j: Jobs, t: Technicians }, from: "j", select: { id: ["j", "id"] } })
  const join = new Data.Class({ kind: "inner", table: "t", on: [{ left: ["j", "technicianId"], right: ["t", "localId"] }] })
  expect(() => Reflect.apply(SqliteView.make, null, [{ ...base, joins: [join], select: { unknown: ["t", "missing"] } }])).toThrow()
  expect(() => Reflect.apply(SqliteView.make, null, [{ ...base, joins: [{ ...join, on: [] }] }])).toThrow()
  expect(() => Reflect.apply(SqliteView.make, null, [{ ...base, joins: [{ ...join, on: [{ left: ["t", "id"], right: ["t", "localId"] }] }] }])).toThrow()
  expect(() => Reflect.apply(SqliteView.make, null, [{ ...base, joins: [{ ...join, on: [{ left: ["j", "is.urgent"], right: ["t", "localId"] }] }] }])).toThrow()
  expect(() => Reflect.apply(SqliteView.make, null, [{ ...base, tables: { ...base.tables, J: Jobs }, joins: [join] }])).toThrow()
  expect(() => Reflect.apply(SqliteView.make, null, [{ ...base, joins: [join], select: { label: ["j", "id"], LABEL: ["t", "id"] } }])).toThrow()
})

it("rejects an operation whose joined table is absent or replaced by a different same-named definition", () => {
  const PersonSchema = Schema.Struct({ name: Schema.String })
  const People = Resource.make({ name: "people", schema: PersonSchema, authorization: Authorization.public, operations: {} })
  const view = SqliteView.make({ tables: { p: People.table }, from: "p", joins: [], select: { name: ["p", "name"] } })
  const RowSchema = Schema.toType(view.schema)
  const RowsSchema = Schema.Array(RowSchema)
  const rpc = Rpc.make("people.names", { success: RowsSchema }).annotate(SqliteView.annotation, [view])
  const group = RpcGroup.make(rpc)
  const commands = new Data.Class({ group, handlers: Layer.empty })
  expect(() => Application.make({ name: "missing", parts: [commands] })).toThrow()
  const WrongPersonSchema = Schema.Struct({ name: Schema.Int })
  const WrongPeople = Resource.make({ name: "people", schema: WrongPersonSchema, authorization: Authorization.public, operations: {} })
  expect(() => Application.make({ name: "mismatch", parts: [WrongPeople, commands] })).toThrow()
})

it("rejects left projections when stored null has application-defined decoding semantics", () => {
  const NullableStringSchema = Schema.NullOr(Schema.String)
  const nullableName = (value: string) => Equivalence.strictEqual<string>()(value, "not recorded") ? null : value

  const StoredNameSchema = pipe(NullableStringSchema, Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value) => value ?? "not recorded"),
    encode: SchemaGetter.transform(nullableName),
  }))

  const PersonSchema = Schema.Struct({ id: identifier(Schema.String), name: StoredNameSchema })
  const People = Table.make({ name: "optional_people", schema: PersonSchema })

  expect(() => SqliteView.make({
    tables: { j: Jobs, p: People }, from: "j",
    joins: [{ kind: "left", table: "p", on: [{ left: ["j", "technicianId"], right: ["p", "id"] }] }],
    select: { name: ["p", "name"] },
  })).toThrow()
})
