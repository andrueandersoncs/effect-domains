import { expect, it } from "@effect/vitest"
import { Data, Effect, Equivalence, Record, Schema, SchemaGetter, pipe } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { SqlClient, SqlSchema } from "effect/unstable/sql"
import { Application, Part } from "effect-domains/application"
import { Authorization } from "effect-domains/authorization"
import { identifier } from "effect-domains/domain"
import { Resource } from "effect-domains/resource"
import { Command } from "effect-domains/command"
import { ReadModel } from "effect-domains/read-model"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
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

const JobListModel = ReadModel.define({
  tables: ReadModel.sources({ job: Jobs }),
  from: "job",
  joins: [],
  select: {
    id: ["job", "id"],
    tenant: ["job", "tenant"],
    urgent: ["job", "is.urgent"],
  },
})
const JobListView = ReadModel.compile(JobListModel)

const JobListPageSpec = ReadModel.page({
  model: JobListModel,
  filter: ["tenant"],
  range: ["id"],
  order: [["urgent", "desc"], ["id", "asc"]],
  limit: 2,
})
const JobListPage = ReadModel.compilePage(JobListPageSpec)

class JobListUnavailable extends Schema.TaggedError<JobListUnavailable>()("JobListUnavailable", {}) {}

const JobListCommand = ReadModel.publish({
  name: "jobs.list",
  unavailable: JobListUnavailable,
  page: JobListPageSpec,
})
const JobListBundle = Command.bundle(JobListCommand)

it.effect("decodes composite left joins without losing booleans, service codecs, or unmatched rows", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([Jobs, Technicians])
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO "jobs.work" (id, tenant, technicianId, "is.urgent") VALUES ('assigned', 'acme', 'sam', 1), ('waiting', 'acme', NULL, 0)`
    yield* sql`INSERT INTO "people""records" (id, tenant, localId, name, onCall) VALUES ('a', 'acme', 'sam', 'stored:Sam', 1), ('b', 'other', 'sam', 'stored:Not Sam', 0)`

    const model = ReadModel.define({
      tables: ReadModel.sources({ "base.jobs": Jobs, 'joined"people': Technicians }),
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
    const view = ReadModel.compile(model)

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

it.effect("derives bounded filtered keyset pages for compiled views", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([Jobs])
    const sql = yield* SqlClient.SqlClient

    yield* sql`INSERT INTO "jobs.work" (id, tenant, technicianId, "is.urgent") VALUES
      ('a', 'acme', NULL, 1),
      ('b', 'acme', NULL, 0),
      ('c', 'acme', NULL, 1),
      ('d', 'other', NULL, 1)`

    const first = yield* JobListPage.handler({ filter: { tenant: "acme" }, limit: 2 })

    expect(first.items).toEqual([
      { id: "a", tenant: "acme", urgent: true },
      { id: "c", tenant: "acme", urgent: true },
    ])

    const cursor = yield* Effect.fromNullishOr(first.nextCursor)
    const second = yield* JobListPage.handler({ filter: { tenant: "acme" }, cursor, limit: 2 })

    expect(second).toEqual({
      items: [{ id: "b", tenant: "acme", urgent: false }],
      nextCursor: null,
    })

    const mismatch = yield* pipe(
      JobListPage.handler({ filter: { tenant: "other" }, cursor, limit: 2 }),
      Effect.flip,
    )

    expect(mismatch._tag).toBe("ReadModelInputError")
  }),
  Effect.provide(database),
))

it.effect("publishes a compiled page as a command without hand-written pass-through fields", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([Jobs])
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO "jobs.work" (id, tenant, technicianId, "is.urgent") VALUES ('a', 'acme', NULL, 1)`
    const client = yield* RpcTest.makeClient(JobListBundle.group)
    const page = yield* client["jobs.list"]({ filter: { tenant: "acme" } })
    expect(page).toEqual({ items: [{ id: "a", tenant: "acme", urgent: true }], nextCursor: null })
  }),
  Effect.provide(JobListBundle.handlers),
  Effect.provide(database),
))

it.effect("snapshots selections so caller mutation cannot redirect a compiled read", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([Jobs])
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO "jobs.work" (id, tenant, technicianId, "is.urgent") VALUES ('job', 'acme', NULL, 0)`
    const select = Record.singleton("value", ["j", "tenant"] as const)
    const model = ReadModel.define({
      tables: ReadModel.sources({ j: Jobs }),
      from: "j",
      joins: [],
      select,
    })
    const view = ReadModel.compile(model)
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
  const compile = (definition: object) =>
    ReadModel.compile(Reflect.apply(ReadModel.define, null, [definition]))
  expect(() => compile({ ...base, joins: [join], select: { unknown: ["t", "missing"] } })).toThrow()
  expect(() => compile({ ...base, joins: [{ ...join, on: [] }] })).toThrow()
  expect(() => compile({ ...base, joins: [{ ...join, on: [{ left: ["t", "id"], right: ["t", "localId"] }] }] })).toThrow()
  expect(() => compile({ ...base, joins: [{ ...join, on: [{ left: ["j", "is.urgent"], right: ["t", "localId"] }] }] })).toThrow()
  expect(() => compile({ ...base, tables: { ...base.tables, J: Jobs }, joins: [join] })).toThrow()
  expect(() => compile({ ...base, joins: [join], select: { label: ["j", "id"], LABEL: ["t", "id"] } })).toThrow()
})

it("rejects a command whose read-model source is absent or replaced by a same-named definition", () => {
  const PersonSchema = Schema.Struct({ name: Schema.String })
  const People = Resource.define({
    name: "people",
    schema: PersonSchema,
    authorization: Authorization.public,
    capabilities: Resource.capabilities(),
  })
  const model = ReadModel.define({
    tables: ReadModel.sources({ p: People }),
    from: "p",
    joins: [],
    select: { name: ["p", "name"] },
  })
  const page = ReadModel.page({ model, order: [["name", "asc"]] })
  const command = ReadModel.publish({
    name: "people.names",
    unavailable: JobListUnavailable,
    page,
  })
  const commands = Command.bundle(command)
  expect(() => Application.compile(Application.define({
    name: "missing",
    parts: [Part.command(commands)],
  }))).toThrow()

  const WrongPersonSchema = Schema.Struct({ name: Schema.Int })
  const WrongPeople = Resource.define({
    name: "people",
    schema: WrongPersonSchema,
    authorization: Authorization.public,
    capabilities: Resource.capabilities(),
  })
  expect(() => Application.compile(Application.define({
    name: "mismatch",
    parts: [Part.resource(WrongPeople), Part.command(commands)],
  }))).toThrow()
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

  expect(() => ReadModel.compile(ReadModel.define({
    tables: ReadModel.sources({ j: Jobs, p: People }),
    from: "j",
    joins: [{ kind: "left", table: "p", on: [{ left: ["j", "technicianId"], right: ["p", "id"] }] }],
    select: { name: ["p", "name"] },
  }))).toThrow()
})
