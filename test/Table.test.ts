import { describe, expect, it } from "@effect/vitest"
import { Array, DateTime, Effect, Equivalence, Function, Option, Schema, Struct, flow, pipe } from "effect"
import { identifier } from "effect-domains/domain"
import { Table, TableField, GreaterThan, GreaterThanOrEqualTo, LessThan, LessThanOrEqualTo, OneOf, MinLength, MaxLength } from "effect-domains/table"
import { SqlClient } from "effect/unstable/sql"
import { renderColumn } from "../packages/effect-domains/src/sqlite-ddl.ts"
import { Resource } from "effect-domains/resource"
import { Authorization } from "effect-domains/authorization"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { prepareTables } from "./prepare-tables.ts"

describe("Table", () => {
  const isMinimumLabelLength = Schema.isMinLength(2)
  const isMaximumLabelLength = Schema.isMaxLength(20)
  const EventLabelSchema = Schema.String.check(isMinimumLabelLength, isMaximumLabelLength)
  const isEventQuantity = Schema.isBetween({ minimum: 1, maximum: 99 })
  const EventQuantitySchema = Schema.Int.check(isEventQuantity)
  const EventStateSchema = Schema.Literals(["queued", "confirmed"])
  const EventNoteSchema = Schema.NullOr(Schema.String)

  const EventSchema = Schema.Struct({
    label: EventLabelSchema,
    quantity: EventQuantitySchema,
    state: EventStateSchema,
    active: Schema.Boolean,
    occurredAt: Schema.DateTimeUtc,
    note: EventNoteSchema,
  })

  interface Event extends Schema.Schema.Type<typeof EventSchema> {}
  const Events = Table.make({ name: "events", schema: EventSchema })
  const DateSchema = Schema.Struct({ date: Schema.DateFromString })
  interface Date extends Schema.Schema.Type<typeof DateSchema> {}
  const Dates = Table.make({ name: "dates", schema: DateSchema })

  const OrderedFieldsSchema = Schema.Struct({
    lower: Schema.Int,
    upper: Schema.Int,
  })

  interface OrderedFields extends Schema.Schema.Type<typeof OrderedFieldsSchema> {}

  const orderedFilter = Schema.makeFilter(
    (value: OrderedFields) => value.lower < value.upper,
  )

  const OrderedSchema = OrderedFieldsSchema.check(orderedFilter)
  interface Ordered extends Schema.Schema.Type<typeof OrderedSchema> {}
  const Ordered = Table.make({ name: "ordered", schema: OrderedSchema })
  const NullableOptionSchema = Schema.OptionFromNullOr(Schema.String)
  const NullableOptionsSchema = Schema.Struct({ value: NullableOptionSchema })
  interface NullableOptions extends Schema.Schema.Type<typeof NullableOptionsSchema> {}

  const NullableOptionsTable = Table.make({
    name: "nullable_options",
    schema: NullableOptionsSchema,
  })

  const SuspendedBooleanSchema = Schema.Struct({
    active: Schema.suspend(() => Schema.Boolean),
    occurredAt: Schema.suspend(() => Schema.DateTimeUtc),
  })

  interface SuspendedBoolean extends Schema.Schema.Type<typeof SuspendedBooleanSchema> {}

  const SuspendedBooleans = Table.make({
    name: "suspended_booleans",
    schema: SuspendedBooleanSchema,
  })

  const NullableSuspendedBooleanSchema = Schema.Struct({
    active: Schema.NullOr(Schema.suspend(() => Schema.Boolean)),
  })

  interface NullableSuspendedBoolean extends Schema.Schema.Type<typeof NullableSuspendedBooleanSchema> {}

  const NullableSuspendedBooleans = Table.make({
    name: "nullable_suspended_booleans",
    schema: NullableSuspendedBooleanSchema,
  })

  const UnicodeLabelSchema = Schema.String.check(
    Schema.isMinLength(2),
    Schema.isMaxLength(2),
  )

  const UnicodeLabelsSchema = Schema.Struct({ label: UnicodeLabelSchema })
  interface UnicodeLabels extends Schema.Schema.Type<typeof UnicodeLabelsSchema> {}

  const UnicodeLabels = Resource.define({ name: "unicode_labels",
  schema: UnicodeLabelsSchema,
  authorization: Authorization.public, capabilities: Resource.capabilities(),  })

  const NumberStringsSchema = Schema.Struct({ value: Schema.NumberFromString })
  interface NumberStrings extends Schema.Schema.Type<typeof NumberStringsSchema> {}

  const NumberStrings = Table.make({
    name: "number_strings",
    schema: NumberStringsSchema,
  })

  it.effect(
    "round-trips native storage codecs without application storage models",
    Effect.fn("Table.roundTripsStorageCodecs")(function* () {
      const dateTime = DateTime.make("2025-01-02T03:04:05.000Z")
      const occurredAt = Option.getOrThrow(dateTime)

      const event = Events.rowSchema.make({
        id: "0192f8d1-ef4e-7dd4-a8f0-ec3d1fe71826",
        label: "arrived",
        quantity: 2,
        state: "queued",
        active: true,
        occurredAt,
        note: null,
      })

      const insert = EventSchema.make({
        label: "arrived",
        quantity: 2,
        state: "queued",
        active: true,
        occurredAt,
        note: null,
      })

      const storedRow = yield* Schema.encodeEffect(Events.storageSchema)(event)
      const decodedRow = yield* Schema.decodeUnknownEffect(Events.storageSchema)(storedRow)
      const storedInsert = yield* Schema.encodeEffect(Events.insertSchema)(insert)
      const decodedInsert = yield* Schema.decodeUnknownEffect(Events.insertSchema)(storedInsert)
      const date = new Date("2025-01-02T00:00:00.000Z")
      const dateValue = DateSchema.make({ date })
      const storedDate = yield* Schema.encodeEffect(Dates.insertSchema)(dateValue)
      const decodedDate = yield* Schema.decodeUnknownEffect(Dates.insertSchema)(storedDate)
      const none = Option.none()
      const storedNone = yield* Schema.encodeEffect(NullableOptionsTable.insertSchema)({ value: none })
      const loadedSome = yield* Schema.decodeUnknownEffect(NullableOptionsTable.insertSchema)({ value: "retained" })

      expect(storedRow).toMatchObject({ active: 1, note: null })
      expect(storedRow.occurredAt).toBe("2025-01-02T03:04:05.000Z")
      expect(decodedRow).toEqual(event)

      const storedInsertExpectation = expect(storedInsert)

      storedInsertExpectation.not.toHaveProperty("id")
      expect(decodedInsert).toEqual(insert)
      expect(typeof storedDate.date).toBe("string")
      const decodedDateMillis = decodedDate.date.getTime()
      const expectedDateMillis = Date.parse("2025-01-02T00:00:00.000Z")
      expect(decodedDateMillis).toBe(expectedDateMillis)
      expect(storedNone).toEqual({ value: null })
      const expectedSome = Option.some("retained")
      expect(loadedSome).toEqual({ value: expectedSome })
    }),
  )

  it.effect(
    "normalizes suspended scalar codecs before storage compilation",
    Effect.fn("Table.normalizesSuspendedScalarCodecs")(function* () {
      const occurredAt = yield* pipe(DateTime.make("2025-01-02T03:04:05.000Z"), Effect.fromOption)
      const value = SuspendedBooleanSchema.make({ active: true, occurredAt })
      const stored = yield* Schema.encodeEffect(SuspendedBooleans.insertSchema)(value)
      const decoded = yield* Schema.decodeUnknownEffect(SuspendedBooleans.insertSchema)(stored)
      const nullableValue = NullableSuspendedBooleanSchema.make({ active: true })

      const nullableStored = yield* Schema.encodeEffect(NullableSuspendedBooleans.insertSchema)(
        nullableValue,
      )

      const nullableDecoded = yield* Schema.decodeUnknownEffect(
        NullableSuspendedBooleans.insertSchema,
      )(nullableStored)

      expect(stored).toEqual({ active: 1, occurredAt: "2025-01-02T03:04:05.000Z" })
      expect(decoded).toEqual(value)
      expect(nullableStored).toEqual({ active: 1 })
      expect(nullableDecoded).toEqual(nullableValue)
    }),
  )

  it.effect(
    "preserves root struct checks after compiling storage fields",
    Effect.fn("Table.preservesRootStructChecks")(function* () {
      const UncheckedOrderedRowSchema = Schema.Struct(Ordered.rowSchema.fields)
      interface UncheckedOrderedRow extends Schema.Schema.Type<typeof UncheckedOrderedRowSchema> {}

      const invalidRow = UncheckedOrderedRowSchema.make({
        id: "0192f8d1-ef4e-7dd4-a8f0-ec3d1fe71826",
        lower: 4,
        upper: 1,
      })

      const invalidOrdered = OrderedFieldsSchema.make({ lower: 4, upper: 1 })

      const invalidInsert = pipe(
        Schema.decodeUnknownEffect(Ordered.insertSchema)(invalidOrdered),
        Effect.match({ onFailure: Function.constant(true), onSuccess: Function.constant(false) }),
      )

      const invalidPersistedRow = pipe(
        Schema.decodeUnknownEffect(Ordered.rowSchema)(invalidRow),
        Effect.match({ onFailure: Function.constant(true), onSuccess: Function.constant(false) }),
      )

      const invalidStorageRow = pipe(
        Schema.encodeUnknownEffect(Ordered.storageSchema)(invalidRow),
        Effect.match({ onFailure: Function.constant(true), onSuccess: Function.constant(false) }),
      )

      const failures = yield* Effect.all([invalidInsert, invalidPersistedRow, invalidStorageRow])

      expect(failures).toEqual([true, true, true])
    }),
  )

  it.effect("publishes storage-level integer and check metadata", () =>
    Effect.sync(() => {
      const snapshot = Table.snapshot(Events)

      const named = (name: string) => (field: (typeof snapshot.fields)[number]) =>
        Equivalence.strictEqual<string>()(field.name, name)

      const active = Array.findFirst(snapshot.fields, named("active"))
      const quantity = Array.findFirst(snapshot.fields, named("quantity"))

      expect(active).toMatchObject({
        value: {
          scalar: "integer",
          checks: [{ _tag: "OneOf", values: [0, 1] }],
        },
      })

      expect(quantity).toMatchObject({
        value: {
          scalar: "integer",
          checks: [
            { _tag: "GreaterThanOrEqualTo", value: 1 },
            { _tag: "LessThanOrEqualTo", value: 99 },
          ],
        },
      })
    }))

  const sqlite = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })

  it.effect("preserves canonical Unicode length semantics through SQLite", () => pipe(
    Effect.gen(function* () {
      yield* prepareTables([Resource.table(UnicodeLabels)])
      const created = yield* Resource.repository(UnicodeLabels).create({ label: "😀" })
      const loaded = yield* Resource.repository(UnicodeLabels).get(created.id)
      expect(loaded.label).toBe("😀")
    }),
    Effect.provide(sqlite),
  ))

  it.effect("compiles nullable enums, numeric unions, templates, and authored codecs", () => Effect.sync(() => {
    enum AlgebraState { first = "first", second = "second" }

    const AlgebraSchema = Schema.Struct({
      enumeration: Schema.NullOr(Schema.Enum(AlgebraState)),
      numeric: Schema.suspend(() => Schema.Literals([1, 2.5])),
      template: Schema.TemplateLiteral([Schema.String, "-", Schema.Number]),
      native: Schema.Boolean,
      authored: Schema.NumberFromString,
      occurredAt: Schema.DateTimeUtc,
      nullable: Schema.NullOr(Schema.Int),
    })

    interface Algebra extends Schema.Schema.Type<typeof AlgebraSchema> {}
    const compiled = Table.make({ name: "algebra", schema: AlgebraSchema })
    const fields = Array.drop(compiled.fields, 1)

    expect(fields).toMatchObject([
      { scalar: "string", nullable: true, checks: [{ _tag: "OneOf", values: ["first", "second"] }] },
      { scalar: "number", checks: [{ _tag: "OneOf", values: [1, 2.5] }] },
      { scalar: "string" },
      { scalar: "integer", checks: [{ _tag: "OneOf", values: [0, 1] }] },
      { scalar: "string" },
      { scalar: "string" },
      { scalar: "integer", nullable: true },
    ])

    expect(compiled.columns.enumeration.orderable).toBe(false)
    expect(compiled.columns.numeric.orderable).toBe(true)
    expect(compiled.columns.template.orderable).toBe(true)
    expect(compiled.columns.native.orderable).toBe(true)
    expect(compiled.columns.authored.orderable).toBe(false)
    expect(compiled.columns.occurredAt.orderable).toBe(true)
    expect(compiled.columns.nullable.orderable).toBe(false)
  }))

  it.effect("derives relation names and expands scoped foreign keys against unique tuples", () =>
    Effect.sync(() => {
      const ParentSchema = Schema.Struct({ tenantId: Schema.String, code: Schema.String })
      const ChildSchema = Schema.Struct({ tenantId: Schema.String, parentId: Schema.String })

      const parent = Table.make({
        name: "scoped_parents",
        schema: ParentSchema,
        relations: { unique: [{ fields: ["tenantId", "id"] }] },
      })

      const ParentIdReference = Table.reference(parent, ["id"])

      const child = Table.make({
        name: "scoped_children",
        schema: ChildSchema,
        relations: {
          foreignKeys: [{
            scope: ["tenantId"],
            fields: ["parentId"],
            references: ParentIdReference,
          }],
          indexes: [{ fields: ["tenantId", "parentId"] }],
        },
      })

      const parentSnapshot = Table.snapshot(parent)
      const childSnapshot = Table.snapshot(child)
      const relationSnapshots = [parentSnapshot, childSnapshot]
      const relationsValidation = Table.validateRelations(relationSnapshots)
      Effect.runSync(relationsValidation)

      expect(parentSnapshot.relations).toMatchObject({
        unique: [{ name: "scoped_parents_tenant_id_id_key", fields: ["tenantId", "id"] }],
      })

      expect(childSnapshot.relations).toMatchObject({
        foreignKeys: [{
          name: "scoped_children_tenant_id_parent_id_fkey",
          fields: ["tenantId", "parentId"],
          references: { fields: ["tenantId", "id"] },
        }],
        indexes: [{ name: "scoped_children_tenant_id_parent_id_idx" }],
      })

      const invalidParent = Table.make({ name: "scoped_parents", schema: ParentSchema })
      const invalidParentSnapshot = Table.snapshot(invalidParent)
      const invalidRelations = Table.validateRelations([invalidParentSnapshot, childSnapshot])
      expect(() => Effect.runSync(invalidRelations)).toThrow()
    }))

  it.effect("retains every historical check in SQLite DDL", () => Effect.sync(() => {
    const field = TableField.make({
      name: "value",
      scalar: "number",
      nullable: false,
      generation: Option.none(),
      checks: [
        GreaterThan.make({ value: 0 }), GreaterThanOrEqualTo.make({ value: 1 }),
        LessThan.make({ value: 10 }), LessThanOrEqualTo.make({ value: 9 }),
        OneOf.make({ values: [1, "a'b"] }), MinLength.make({ value: 1 }), MaxLength.make({ value: 9 }),
      ],
    })

    const rendered = renderColumn(field, false)
    expect(rendered).toBe(`"value" REAL NOT NULL CHECK (typeof("value") IN ('integer', 'real')) CHECK ("value" > 0) CHECK ("value" >= 1) CHECK ("value" < 10) CHECK ("value" <= 9) CHECK ("value" IN (1, 'a''b')) CHECK (length("value") >= 1) CHECK (length("value") <= 9)`)
  }))

  it.effect("enforces numeric and enum checks and generates UUIDs in the database", () => pipe(
    Effect.gen(function* () {
      const BoundsSchema = Schema.Struct({
        value: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThan(3)),
        state: Schema.Literals(["queued", "confirmed"]),
      })

      interface Bounds extends Schema.Schema.Type<typeof BoundsSchema> {}
      const bounds = Table.make({ name: "bounds", schema: BoundsSchema })
      yield* prepareTables([bounds])
      const sql = yield* SqlClient.SqlClient
      const created = yield* sql`INSERT INTO bounds (value, state) VALUES (1, 'queued') RETURNING *`
      const row = Array.head(created)
      const stored = Option.getOrThrow(row)
      const decoded = yield* Schema.decodeUnknownEffect(bounds.storageSchema)(stored)
      expect(decoded.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      const lower = yield* Effect.result(sql`INSERT INTO bounds (value, state) VALUES (0, 'queued')`)
      const upper = yield* Effect.result(sql`INSERT INTO bounds (value, state) VALUES (3, 'queued')`)
      const integer = yield* Effect.result(sql`INSERT INTO bounds (value, state) VALUES (1.5, 'queued')`)
      const enumeration = yield* Effect.result(sql`INSERT INTO bounds (value, state) VALUES (1, 'invalid')`)
      expect(lower._tag).toBe("Failure")
      expect(upper._tag).toBe("Failure")
      expect(integer._tag).toBe("Failure")
      expect(enumeration._tag).toBe("Failure")
    }),
    Effect.provide(sqlite),
  ))

  it.effect("rejects ambiguous or lossy representations", () =>
    Effect.sync(() => {
      const IdentifiedStringSchema = pipe(Schema.String, identifier)
      const IdentifiedNumberSchema = pipe(Schema.Number, identifier)

      const AmbiguousSchema = Schema.Struct({
        first: IdentifiedStringSchema,
        second: IdentifiedNumberSchema,
      })

      interface Ambiguous extends Schema.Schema.Type<typeof AmbiguousSchema> {}
      const OptionalNameSchema = Schema.optionalKey(Schema.String)
      const OptionalSchema = Schema.Struct({ name: OptionalNameSchema })
      interface Optional extends Schema.Schema.Type<typeof OptionalSchema> {}
      const OptionValueSchema = Schema.Option(Schema.String)
      const OptionSchema = Schema.Struct({ value: OptionValueSchema })
      interface Option extends Schema.Schema.Type<typeof OptionSchema> {}
      const NestedValueSchema = Schema.Struct({ value: Schema.String })
      interface NestedValue extends Schema.Schema.Type<typeof NestedValueSchema> {}
      const NestedSchema = Schema.Struct({ nested: NestedValueSchema })
      interface Nested extends Schema.Schema.Type<typeof NestedSchema> {}
      const CyclicValueSchema: Schema.Codec<never> = Schema.suspend(() => CyclicValueSchema)
      const CyclicSchema = Schema.Struct({ value: CyclicValueSchema })
      interface Cyclic extends Schema.Schema.Type<typeof CyclicSchema> {}
      const NullableIdentifierSchema = pipe(Schema.NullOr(Schema.String), identifier)
      const NullableIdentifierTableSchema = Schema.Struct({ id: NullableIdentifierSchema })
      interface NullableIdentifierTable extends Schema.Schema.Type<typeof NullableIdentifierTableSchema> {}

      expect(() => Table.make({ name: "ambiguous", schema: AmbiguousSchema })).toThrow()
      expect(() => Table.make({ name: "optional", schema: OptionalSchema })).toThrow()
      expect(() => Table.make({ name: "option", schema: OptionSchema })).toThrow()
      expect(() => Table.make({ name: "nested", schema: NestedSchema })).toThrow()
      expect(() => Table.make({ name: "cyclic", schema: CyclicSchema })).toThrow()
      expect(() => Table.make({ name: "nullable_identifier", schema: NullableIdentifierTableSchema })).toThrow()

    }))

  it.effect("projects selected fields into decodable SQLite JSON objects", () => pipe(
    Effect.gen(function* () {
      const ProjectionEventsSchema = Schema.Struct({
        id: identifier(Schema.String),
        active: Schema.Boolean,
      })

      const Events = Table.make({
        name: "projection_events",
        schema: ProjectionEventsSchema,
      })

      const projection = Table.project(Events, ["id", "active"])
      const ResultSchema = Schema.Array(Schema.Struct({ body: projection.json }))
      yield* prepareTables([Events])
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO projection_events (id, active) VALUES ('event-a', 1)`
      const rows = yield* sql<{ body: string }>`SELECT ${projection.object(sql, "e")} AS body FROM projection_events e`
      const result = yield* Schema.decodeUnknownEffect(ResultSchema)(rows)
      expect(result).toEqual([{ body: { id: "event-a", active: true } }])
    }),
    Effect.provide(sqlite),
  ))

})
