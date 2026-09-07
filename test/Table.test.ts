import { describe, expect, it } from "@effect/vitest"
import { Array, DateTime, Effect, Equivalence, Function, Option, Schema, Struct, flow, pipe } from "effect"
import { identifier } from "../src/domain.ts"
import { Table, TableDefinitionError } from "../src/table.ts"

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
    "preserves root struct checks after compiling storage fields",
    Effect.fn("Table.preservesRootStructChecks")(function* () {
      const invalidOrdered = OrderedFieldsSchema.make({ lower: 4, upper: 1 })
      const decoded = Schema.decodeUnknownEffect(Ordered.insertSchema)(invalidOrdered)

      const failure = yield* pipe(
        decoded,
        Effect.match({ onFailure: Function.constant(true), onSuccess: Function.constant(false) }),
      )

      expect(failure).toBe(true)
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
      expect(() => Table.make({ name: "ambiguous", schema: AmbiguousSchema })).toThrow(TableDefinitionError)
      expect(() => Table.make({ name: "optional", schema: OptionalSchema })).toThrow(TableDefinitionError)
      expect(() => Table.make({ name: "option", schema: OptionSchema })).toThrow(TableDefinitionError)
      expect(() => Table.make({ name: "nested", schema: NestedSchema })).toThrow(TableDefinitionError)

    }))
})
