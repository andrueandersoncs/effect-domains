import { describe, expect, it } from "@effect/vitest"
import { Effect, Equivalence, Function, Option, pipe, Ref, Schema } from "effect"
import {
  DefaultTableIdentifierSchema,
  Domain,
  Table,
  TableDefinitionError,
  TableError,
} from "../index.ts"
import { type TableField, TableStore } from "../src/Table.ts"

const GeneratedRecordSchema = Schema.Struct({
  title: Schema.String,
  score: Schema.Number,
})

interface GeneratedRecord extends
  Schema.Schema.Type<typeof GeneratedRecordSchema> {}

const GeneratedRecordsConfig = { name: "generated_records" } as const

const GeneratedRecords = Table.make(
  GeneratedRecordSchema,
  GeneratedRecordsConfig,
)

const ExplicitIdentifierSchema = pipe(
  Schema.NumberFromString,
  Domain.identifier,
)

const ExplicitRecordSchema = Schema.Struct({
  recordNumber: ExplicitIdentifierSchema,
  title: Schema.String,
  score: Schema.Number,
})

interface ExplicitRecord extends
  Schema.Schema.Type<typeof ExplicitRecordSchema> {}

const ExplicitRecordsConfig = { name: "explicit_records" } as const

const ExplicitRecords = Table.make(
  ExplicitRecordSchema,
  ExplicitRecordsConfig,
)

const OptionalTitleSchema = Schema.optionalKey(Schema.String)

const OptionalRecordSchema = Schema.Struct({
  title: OptionalTitleSchema,
})

interface OptionalRecord extends
  Schema.Schema.Type<typeof OptionalRecordSchema> {}

const OptionalRecordsConfig = { name: "optional_records" } as const

const makeOptionalRecords = () =>
  Table.make(OptionalRecordSchema, OptionalRecordsConfig)

const OptionalRecordError = new TableDefinitionError(
  OptionalRecordsConfig.name,
  "field title must be required",
)

const BooleanRecordSchema = Schema.Struct({
  active: Schema.Boolean,
})

interface BooleanRecord extends
  Schema.Schema.Type<typeof BooleanRecordSchema> {}

const BooleanRecordsConfig = { name: "boolean_records" } as const

const makeBooleanRecords = () =>
  Table.make(BooleanRecordSchema, BooleanRecordsConfig)

const BooleanRecordError = new TableDefinitionError(
  BooleanRecordsConfig.name,
  "field active must encode to String or Number",
)

const SymbolField = Symbol("value")

const SymbolRecordSchema = Schema.Struct({
  [SymbolField]: Schema.String,
})

interface SymbolRecord extends
  Schema.Schema.Type<typeof SymbolRecordSchema> {}

const SymbolRecordsConfig = { name: "symbol_records" } as const

const makeSymbolRecords = () =>
  Table.make(SymbolRecordSchema, SymbolRecordsConfig)

const SymbolRecordError = new TableDefinitionError(
  SymbolRecordsConfig.name,
  "field names must be strings",
)

const FirstIdentifierSchema = pipe(Schema.String, Domain.identifier)
const SecondIdentifierSchema = pipe(Schema.Number, Domain.identifier)

const AmbiguousRecordSchema = Schema.Struct({
  firstId: FirstIdentifierSchema,
  secondId: SecondIdentifierSchema,
})

interface AmbiguousRecord extends
  Schema.Schema.Type<typeof AmbiguousRecordSchema> {}

const AmbiguousRecordsConfig = { name: "ambiguous_records" } as const

const makeAmbiguousRecords = () =>
  Table.make(AmbiguousRecordSchema, AmbiguousRecordsConfig)

const AmbiguousRecordError = new TableDefinitionError(
  AmbiguousRecordsConfig.name,
  "schema must contain at most one Domain.identifier field",
)

const ReservedIdentifierRecordSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
})

interface ReservedIdentifierRecord extends
  Schema.Schema.Type<typeof ReservedIdentifierRecordSchema> {}

const ReservedIdentifierRecordsConfig = {
  name: "reserved_id_records",
} as const

const makeReservedIdentifierRecords = () =>
  Table.make(
    ReservedIdentifierRecordSchema,
    ReservedIdentifierRecordsConfig,
  )

const ReservedIdentifierRecordError = new TableDefinitionError(
  ReservedIdentifierRecordsConfig.name,
  "field id must use Domain.identifier when overriding the default UUIDv7 identifier",
)

const ValidUuidV4 = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
const NoGeneration = Option.none<"uuidv7">()
const UuidV7Generation = Option.some<"uuidv7">("uuidv7")

const GeneratedFieldMetadata: ReadonlyArray<TableField> = [
  {
    name: "id",
    scalar: "string",
    generation: UuidV7Generation,
  },
  {
    name: "title",
    scalar: "string",
    generation: NoGeneration,
  },
  {
    name: "score",
    scalar: "number",
    generation: NoGeneration,
  },
]

const ExplicitFieldMetadata: ReadonlyArray<TableField> = [
  {
    name: "recordNumber",
    scalar: "string",
    generation: NoGeneration,
  },
  {
    name: "title",
    scalar: "string",
    generation: NoGeneration,
  },
  {
    name: "score",
    scalar: "number",
    generation: NoGeneration,
  },
]

const isSame = Equivalence.strictEqual<unknown>()

const MissingIdentifierRowInput = {
  title: "Mechanical derivation",
  score: 5,
} as const

const reportsSuccess = Effect.match({
  onFailure: Function.constant(false),
  onSuccess: Function.constant(true),
})

const verifiesGeneratedIdentifier = Effect.fn(
  "TableTest.verifiesGeneratedIdentifier",
)(function* (row: unknown) {
  const decoded = yield* Schema.decodeUnknownEffect(GeneratedRecords.rowSchema)(
    row,
  )

  const invalidIdentifierSucceeded = yield* pipe(
    Schema.decodeUnknownEffect(DefaultTableIdentifierSchema)(ValidUuidV4),
    reportsSuccess,
  )

  const missingIdentifierSucceeded = yield* pipe(
    Schema.decodeUnknownEffect(GeneratedRecords.rowSchema)(
      MissingIdentifierRowInput,
    ),
    reportsSuccess,
  )

  expect(decoded).toEqual(row)
  expect(invalidIdentifierSucceeded).toBe(false)
  expect(missingIdentifierSucceeded).toBe(false)
})

const verifiesCreateTableDelegation = Effect.gen(function* () {
  const receivedTable = yield* Ref.make<unknown>(undefined)

  const store = TableStore.of({
    createTable: (table) => Ref.set(receivedTable, table),
  })

  const createTable = GeneratedRecords.createTable()

  yield* pipe(
    createTable,
    Effect.provideService(TableStore, store),
  )

  const observedTable = yield* Ref.get(receivedTable)

  expect(observedTable).toBe(GeneratedRecords)
})

const verifiesCreateTableFailure = Effect.gen(function* () {
  const cause = "database unavailable"
  const tableError = new TableError(GeneratedRecords.name, cause)

  const store = TableStore.of({
    createTable: () => Effect.fail(tableError),
  })

  const createTable = GeneratedRecords.createTable()

  const failure = yield* pipe(
    createTable,
    Effect.provideService(TableStore, store),
    Effect.flip,
  )

  expect(failure).toBe(tableError)
  expect(failure.operation).toBe("createTable")
  expect(failure.table).toBe("generated_records")
  expect(failure.cause).toBe(cause)
  expect(failure.message).toBe("Table creation failed for generated_records")
})

describe("Table", () => {
  it.effect("adds a generated UUIDv7 identifier when none is declared", () =>
    Effect.sync(() => {
      const rowSchemaIsSourceSchema = isSame(
        GeneratedRecords.rowSchema,
        GeneratedRecordSchema,
      )

      expect(GeneratedRecords.name).toBe("generated_records")
      expect(GeneratedRecords.schema).toBe(GeneratedRecordSchema)
      expect(rowSchemaIsSourceSchema).toBe(false)
      expect(GeneratedRecords.identifier).toBe("id")
      expect(GeneratedRecords.identifierSchema).toBe(
        GeneratedRecords.rowSchema.fields.id,
      )
      expect(GeneratedRecords.identifierSchema).toBe(
        DefaultTableIdentifierSchema,
      )
      expect(GeneratedRecords.fields).toEqual(GeneratedFieldMetadata)
    }))

  it.effect.prop(
    "generates valid rows from the derived row schema",
    [GeneratedRecords.rowSchema],
    ([row]) => verifiesGeneratedIdentifier(row),
  )

  it.effect("uses an explicit identifier and compiles encoded scalar metadata", () =>
    Effect.sync(() => {
      expect(ExplicitRecords.schema).toBe(ExplicitRecordSchema)
      expect(ExplicitRecords.rowSchema).toBe(ExplicitRecordSchema)
      expect(ExplicitRecords.identifier).toBe("recordNumber")
      expect(ExplicitRecords.identifierSchema).toBe(ExplicitIdentifierSchema)
      expect(ExplicitRecords.fields).toEqual(ExplicitFieldMetadata)
    }))

  it.effect("rejects optional fields", () =>
    Effect.sync(() => {
      expect(makeOptionalRecords).toThrow(TableDefinitionError)
      expect(makeOptionalRecords).toThrow(OptionalRecordError.message)
    }))

  it.effect("rejects fields that do not encode to a supported scalar", () =>
    Effect.sync(() => {
      expect(makeBooleanRecords).toThrow(TableDefinitionError)
      expect(makeBooleanRecords).toThrow(BooleanRecordError.message)
    }))

  it.effect("rejects non-string field names", () =>
    Effect.sync(() => {
      expect(makeSymbolRecords).toThrow(TableDefinitionError)
      expect(makeSymbolRecords).toThrow(SymbolRecordError.message)
    }))

  it.effect("rejects multiple explicit identifiers", () =>
    Effect.sync(() => {
      expect(makeAmbiguousRecords).toThrow(TableDefinitionError)
      expect(makeAmbiguousRecords).toThrow(AmbiguousRecordError.message)
    }))

  it.effect("rejects an unannotated id field reserved by generated identity", () =>
    Effect.sync(() => {
      expect(makeReservedIdentifierRecords).toThrow(TableDefinitionError)
      expect(makeReservedIdentifierRecords).toThrow(
        ReservedIdentifierRecordError.message,
      )
    }))

  it.effect(
    "delegates creation to the runtime TableStore",
    Function.constant(verifiesCreateTableDelegation),
  )

  it.effect(
    "preserves TableStore creation failures",
    Function.constant(verifiesCreateTableFailure),
  )
})
