import { describe, expect, it } from "@effect/vitest"
import { Array, DateTime, Effect, Equivalence, Function, Option, Schema, Struct, flow, pipe } from "effect"
import { identifier } from "effect-domains/domain"
import { Table } from "effect-domains/table"
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

  const UnicodeLabels = Resource.make({
    name: "unicode_labels",
    schema: UnicodeLabelsSchema,
    authorization: Authorization.public,
    operations: [],
  })

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
      yield* prepareTables([UnicodeLabels.table])
      const created = yield* UnicodeLabels.repository.create({ label: "😀" })
      const loaded = yield* UnicodeLabels.repository.get(created.id)
      expect(loaded.label).toBe("😀")
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
})
