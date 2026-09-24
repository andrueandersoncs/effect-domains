import { Array, Data, Effect, Equivalence, Function, Match, Option, Predicate, Record, Schema, SchemaAST, Struct, flow, pipe } from "effect"
import { DomainIdentifier, type StructSchema, UuidV7Schema } from "./domain.ts"
import { FieldIR, ScalarSchema, SchemaField, scalarChecks, type ScalarF } from "./schema-field.ts"

import {
  GreaterThan,
  GreaterThanOrEqualTo,
  isOneOfCheck,
  LessThan,
  LessThanOrEqualTo,
  OneOf,
  type TableCheck,
} from "./table-check-model.ts"

import { TableDefinitionError } from "./physical-table-definition-error.ts"
import { TableField } from "./physical-table-field.ts"
import { isNumericTableScalar } from "./physical-table-scalar.ts"

const DefaultIdentifierFields = Record.singleton("id", UuidV7Schema)
const NoGeneration = Option.none<"uuidv7">()
const GeneratedIdentifierGeneration = Option.some<"uuidv7">("uuidv7")

const DefaultIdentifierField = TableField.make({
  name: "id",
  scalar: "string",
  nullable: false,
  generation: GeneratedIdentifierGeneration,
  checks: [],
})

const unsupportedTableScalar = Effect.fn("Table.unsupportedScalar")(function* (table: string, field: string) {
  return yield* TableDefinitionError.make({ table, reason: `field ${field} must encode to a supported scalar` })
})


const ownValue = (value: unknown, key: string | symbol) =>
  Predicate.hasProperty(value, key) ? value[key] : undefined

const representationId = (value: unknown) => ownValue(value, "id")
const DateTimeUtcId = "effect/schema/DateTimeUtc"
const IntegerId = "effect/schema/isInt"

const comparisonChecks = (representation: unknown): ReadonlyArray<TableCheck> => {
  const payload = ownValue(representation, "payload")
  const id = representationId(representation)

  const check = (key: string, constructor: typeof GreaterThan | typeof GreaterThanOrEqualTo | typeof LessThan | typeof LessThanOrEqualTo) => {
    const value = ownValue(payload, key)

    return Predicate.isNumber(value) ? [constructor.make({ value })] : []
  }

  return pipe(Match.value(id),
    Match.when("effect/schema/isGreaterThan", () => check("exclusiveMinimum", GreaterThan)),
    Match.when("effect/schema/isGreaterThanOrEqualTo", () => check("minimum", GreaterThanOrEqualTo)),
    Match.when("effect/schema/isLessThan", () => check("exclusiveMaximum", LessThan)),
    Match.when("effect/schema/isLessThanOrEqualTo", () => check("maximum", LessThanOrEqualTo)),
    Match.when("effect/schema/isBetween", () => {
      const minimum = ownValue(payload, "minimum")
      const maximum = ownValue(payload, "maximum")
      const valid = Predicate.isNumber(minimum) && Predicate.isNumber(maximum)

      if (!valid) return []

      const exclusiveMinimum = ownValue(payload, "exclusiveMinimum")
      const exclusiveMaximum = ownValue(payload, "exclusiveMaximum")
      const lowerSchema = Equivalence.strictEqual<unknown>()(exclusiveMinimum, true) ? GreaterThan : GreaterThanOrEqualTo
      const upperSchema = Equivalence.strictEqual<unknown>()(exclusiveMaximum, true) ? LessThan : LessThanOrEqualTo

      return [lowerSchema.make({ value: minimum }), upperSchema.make({ value: maximum })]
    }),
    Match.orElse(() => []),
  )
}

// Fold once because scalar, nullability, checks, ordering, and codecs share structure.
class ScalarCompilation extends Data.Class<{
  readonly scalar: Option.Option<TableField["scalar"]>
  readonly nullable: boolean
  readonly checks: ReadonlyArray<TableCheck>
  readonly orderable: boolean
  readonly storageCodec: Option.Option<Schema.Constraint>
}> {}

const scalarAlgebra = (table: string, field: string) => (
  layer: ScalarF<Effect.Effect<ScalarCompilation, TableDefinitionError>>,
): Effect.Effect<ScalarCompilation, TableDefinitionError> => {
  const filters = scalarChecks(layer.ast)
  const checksForFilter = (filter: SchemaAST.Filter<unknown>) => comparisonChecks(filter.annotations?.representation)
  const checks = Array.flatMap(filters, checksForFilter)
  const scalar = Option.none<TableField["scalar"]>()
  const storageCodec = Option.none<Schema.Constraint>()
  const base = new ScalarCompilation({ scalar, nullable: false, checks, orderable: true, storageCodec })

  const literals = (values: ReadonlyArray<string | number>): Effect.Effect<ScalarCompilation, TableDefinitionError> => {
    const empty = Array.isReadonlyArrayEmpty(values)

    if (empty) return unsupportedTableScalar(table, field)

    const strings = Array.every(values, Predicate.isString)
    const numbers = Array.every(values, Predicate.isNumber)
    const supported = strings || numbers

    if (!supported) return unsupportedTableScalar(table, field)

    const integers = Array.every(values, Number.isSafeInteger)
    const numeric = integers ? "integer" : "number"
    const scalar = Option.some<TableField["scalar"]>(strings ? "string" : numeric)
    const oneOf = OneOf.make({ values })
    const result = new ScalarCompilation({ ...base, scalar, checks: [...checks, oneOf] })

    return Effect.succeed(result)
  }

  const leaf = (ast: SchemaAST.AST) => pipe(Match.value(ast),
    Match.tag("Null", () => pipe(new ScalarCompilation({ ...base, nullable: true, orderable: false }), Effect.succeed)),
    Match.tag("String", "TemplateLiteral", () => {
      const scalar = Option.some("string" as const)
      const result = new ScalarCompilation({ ...base, scalar })

      return Effect.succeed(result)
    }),
    Match.tag("Number", () => {
      const integerCheck = (filter: SchemaAST.Filter<unknown>) => {
        const id = representationId(filter.annotations?.representation)

        return Equivalence.strictEqual<unknown>()(id, IntegerId)
      }

      const integer = Array.some(filters, integerCheck)
      const scalar = Option.some(integer ? "integer" as const : "number" as const)
      const result = new ScalarCompilation({ ...base, scalar })

      return Effect.succeed(result)
    }),
    Match.tag("Boolean", () => {
      const scalar = Option.some("integer" as const)
      const storageCodec = Option.some(Schema.BooleanFromBit)
      const result = new ScalarCompilation({ ...base, scalar, storageCodec })

      return Effect.succeed(result)
    }),
    Match.tag("Declaration", (declaration) => {
      const id = representationId(declaration.annotations?.representation)
      const dateTime = Equivalence.strictEqual<unknown>()(id, DateTimeUtcId)

      if (!dateTime) return unsupportedTableScalar(table, field)

      const scalar = Option.some("string" as const)
      const storageCodec = Option.some(Schema.DateTimeUtcFromString)
      const result = new ScalarCompilation({ ...base, scalar, storageCodec })

      return Effect.succeed(result)
    }),
    Match.tag("Literal", ({ literal }) => {
      const supported = Predicate.isString(literal) || Predicate.isNumber(literal)

      return supported ? literals([literal]) : unsupportedTableScalar(table, field)
    }),
    Match.tag("Enum", flow(Struct.get<SchemaAST.Enum, "enums">("enums"), Array.map(([, value]) => value), literals)),
    Match.orElse(() => unsupportedTableScalar(table, field)),
  )

  const compileUnion = Effect.fn("TableCompiler.union")(function* (
    { members: children }: Extract<ScalarF<Effect.Effect<ScalarCompilation, TableDefinitionError>>, { readonly _tag: "Union" }>,
  ) {
    const members = yield* Effect.all(children)
    const hasScalar = (member: ScalarCompilation) => Option.isSome(member.scalar)
    const physical = Array.filter(members, hasScalar)
    const head = Array.head(physical)

    if (Option.isNone(head)) return yield* unsupportedTableScalar(table, field)

    const first = Option.getOrThrow(head)
    const sameScalar = (member: ScalarCompilation) => Option.makeEquivalence(Equivalence.strictEqual<TableField["scalar"]>())(member.scalar, first.scalar)
    const isNumeric = (member: ScalarCompilation) => Option.exists(member.scalar, isNumericTableScalar)
    const uniform = Array.every(physical, sameScalar)
    const numeric = Array.every(physical, isNumeric)
    const supported = uniform || numeric

    if (!supported) return yield* unsupportedTableScalar(table, field)

    const nullable = Array.some(members, Struct.get("nullable"))
    const orderable = Array.every(members, Struct.get("orderable"))
    const single = Equivalence.strictEqual<number>()(physical.length, 1)
    // Merge literal sets because alternative predicates cannot be conjoined in SQL.
    const choices = (member: ScalarCompilation) => Array.findFirst(member.checks, isOneOfCheck)
    const values = pipe(physical, Array.map(choices), Option.all)

    const unionChecks = single ? first.checks : pipe(values, Option.match({
      onNone: () => [],
      onSome: (sets) => [OneOf.make({ values: Array.flatMap(sets, Struct.get("values")) })],
    }))

    const scalar = uniform ? first.scalar : Option.some("number" as const)
    const storageCodec = single ? first.storageCodec : Option.none<Schema.Constraint>()

    return new ScalarCompilation({ scalar, nullable, checks: [...checks, ...unionChecks], orderable, storageCodec })
  })

  return pipe(Match.value(layer), Match.tagsExhaustive({
    Leaf: ({ ast }) => leaf(ast),
    Unsupported: () => unsupportedTableScalar(table, field),
    Collection: () => unsupportedTableScalar(table, field),
    Encoding: ({ value }) => pipe(value, Effect.map((encoded) => new ScalarCompilation({ ...encoded, orderable: false }))),
    Suspend: ({ value }) => pipe(value, Effect.map((inner) => new ScalarCompilation({ ...inner, checks: [...checks, ...inner.checks] }))),
    Union: compileUnion,
  }))
}

const compileScalar = (table: string, field: string, ast: SchemaAST.AST) =>
  ScalarSchema.fold("storage", scalarAlgebra(table, field))(ast)

export interface TableColumn {
  readonly storageSchema: Schema.Constraint
  readonly orderable: boolean
  readonly canonical: Option.Option<FieldIR>
  readonly transformsStoredNull: boolean
}

class CompiledField extends Data.Class<TableColumn & {
  readonly field: TableField
}> {}

const storageFieldFor = Effect.fn("Table.storageFieldFor")(function* (
  table: string,
  field: string,
  schema: Schema.Constraint,
) {
  const canonical = SchemaField.compile(schema)
  const transformsStoredNull = SchemaField.transformsStoredNull(schema.ast)
  const compiled = yield* compileScalar(table, field, schema.ast)

  if (Option.isNone(compiled.scalar)) return yield* unsupportedTableScalar(table, field)

  if (Option.isNone(compiled.storageCodec)) {
    return { ...compiled, canonical, transformsStoredNull, storageSchema: schema }
  }

  const typeAst = SchemaAST.toType(schema.ast)
  const decoded = yield* compileScalar(table, field, typeAst)

  if (Option.isNone(decoded.storageCodec)) return yield* unsupportedTableScalar(table, field)

  const codec = decoded.nullable ? Schema.NullOr(decoded.storageCodec.value) : decoded.storageCodec.value
  const storageSchema = Schema.decodeTo(schema)(codec)
  const storedAst = SchemaAST.toEncoded(storageSchema.ast)
  const stored = yield* compileScalar(table, field, storedAst)

  return { ...stored, canonical, transformsStoredNull, orderable: compiled.orderable, storageSchema }
})

const storageFieldEntry = (compiled: CompiledField) =>
  [compiled.field.name, compiled.storageSchema] as const

const compiledFieldEntry = (compiled: CompiledField) =>
  [compiled.field.name, {
    storageSchema: compiled.storageSchema,
    orderable: compiled.orderable,
    canonical: compiled.canonical,
    transformsStoredNull: compiled.transformsStoredNull,
  }] as const

const compileStorageSchema = (schema: StructSchema, fields: ReadonlyArray<CompiledField>) => {
  const entries = Array.map(fields, storageFieldEntry)
  const storageFields = Record.fromEntries(entries)
  const StoredRowSchema = Schema.Struct(storageFields)

  interface StoredRow extends Schema.Schema.Type<typeof StoredRowSchema> {}

  const typeAst = SchemaAST.toType(schema.ast)

  return typeAst.checks ? StoredRowSchema.check(...typeAst.checks) : StoredRowSchema
}

type IdentifierName<S extends StructSchema> = {
  [K in Extract<keyof S["fields"], string>]: S["fields"][K] extends import("effect").Brand.Brand<typeof DomainIdentifier>
    ? K
    : never
}[Extract<keyof S["fields"], string>]

type RowSchema<S extends StructSchema> = [IdentifierName<S>] extends [never]
  ? Schema.Struct<Readonly<typeof DefaultIdentifierFields> & S["fields"]>
  : S

type IdentifierSchema<S extends StructSchema> = [IdentifierName<S>] extends [never]
  ? typeof DefaultIdentifierFields.id
  : S["fields"][IdentifierName<S>]

export const withImplicitIdentifier = <Fields extends Schema.Struct.Fields>(schema: Schema.Struct<Fields>) =>
  schema.mapFields((fields) => Struct.assign(fields, DefaultIdentifierFields), { unsafePreserveChecks: true })

const hasIdentifier = (schema: Schema.Constraint) => {
  const annotations = Schema.resolveAnnotations(schema)
  const identifier = annotations?.[DomainIdentifier]

  return Predicate.isBoolean(identifier) && identifier
}

const sourceField = <S extends StructSchema>(schema: S) => (name: string) =>
  Record.get(schema.fields, name)

const compileField = <S extends StructSchema>(table: string, schema: S) =>
  Effect.fn("Table.compileField")(function* (property: SchemaAST.PropertySignature) {
    const stringName = Predicate.isString(property.name)

    if (!stringName) return yield* TableDefinitionError.make({ table, reason: "field names must be strings" })

    const optional = SchemaAST.isOptional(property.type)

    if (optional) return yield* TableDefinitionError.make({ table, reason: `field ${property.name} must be required` })

    const fieldOption = sourceField(schema)(property.name)
    const fieldSchema = Option.getOrThrow(fieldOption)

    const {
      canonical,
      transformsStoredNull,
      storageSchema,
      scalar,
      nullable,
      checks,
      orderable,
    } = yield* storageFieldFor(table, property.name, fieldSchema)

    if (Option.isNone(scalar)) return yield* unsupportedTableScalar(table, property.name)

    const field = TableField.make({ name: property.name, scalar: scalar.value, nullable, generation: NoGeneration, checks })

    return new CompiledField({ field, storageSchema, orderable, canonical, transformsStoredNull })
  })

const compiledIdentifier = <S extends StructSchema>(schema: S) => (compiled: CompiledField) =>
  pipe(sourceField(schema)(compiled.field.name), Option.exists(hasIdentifier))

const compiledFields = (compiled: ReadonlyArray<CompiledField>) =>
  Array.map(compiled, Struct.get("field"))

const compiledColumns = (compiled: ReadonlyArray<CompiledField>) =>
  pipe(compiled, Array.map(compiledFieldEntry), Record.fromEntries)

const namedIdentifierField = (value: CompiledField) =>
  Equivalence.strictEqual<string>()(value.field.name, "id")

const compileTable = Effect.fn("Table.compile")(function* <const Name extends string, const S extends StructSchema>(name: Name, schema: S) {
  const encodedSchema = Schema.toEncoded(schema)
  const flat = SchemaAST.isObjects(encodedSchema.ast)

  if (!flat) return yield* TableDefinitionError.make({ table: name, reason: "schema must encode to a flat struct" })

  const indexed = encodedSchema.ast.indexSignatures.length > 0

  if (indexed) return yield* TableDefinitionError.make({ table: name, reason: "schema must not contain index signatures" })

  const compiled = yield* Effect.forEach(
    encodedSchema.ast.propertySignatures,
    compileField(name, schema),
  )

  const identifiers = Array.filter(compiled, compiledIdentifier(schema))
  const multipleIdentifiers = Array.length(identifiers) > 1

  if (multipleIdentifiers) return yield* TableDefinitionError.make({ table: name, reason: "schema must contain at most one Domain.identifier field" })

  const identifier = Array.head(identifiers)
  const nullableIdentifier = pipe(identifier, Option.filter((value) => value.field.nullable))

  if (Option.isSome(nullableIdentifier)) {
    return yield* TableDefinitionError.make({
      table: name,
      reason: `identifier field ${nullableIdentifier.value.field.name} must not encode to null`,
    })
  }

  const implicit = Option.isNone(identifier)
  const hasId = Array.some(compiled, namedIdentifierField)
  const ambiguousId = implicit && hasId

  if (ambiguousId) {
    return yield* TableDefinitionError.make({
      table: name,
      reason: "field id must use Domain.identifier when overriding the default UUIDv7 identifier",
    })
  }

  const rowSchema = implicit ? withImplicitIdentifier(schema) : schema
  const defaultCanonical = SchemaField.compile(UuidV7Schema)
  const defaultTransformsStoredNull = SchemaField.transformsStoredNull(UuidV7Schema.ast)

  const defaultKey = new CompiledField({
    field: DefaultIdentifierField,
    storageSchema: UuidV7Schema,
    orderable: true,
    canonical: defaultCanonical,
    transformsStoredNull: defaultTransformsStoredNull,
  })

  const key = pipe(identifier, Option.getOrElse(Function.constant(defaultKey)))
  const storedFields = implicit ? Array.prepend(compiled, key) : compiled
  const identifierField = sourceField(rowSchema)(key.field.name)
  const identifierSchema = Option.getOrThrow(identifierField)
  const insertSchema = compileStorageSchema(schema, compiled)
  const storageSchema = implicit ? compileStorageSchema(rowSchema, storedFields) : insertSchema

  return {
    _tag: "Table" as const,
    name,
    rowSchema,
    identifier: key.field.name,
    identifierSchema,
    fields: compiledFields(storedFields),
    insertSchema,
    storageSchema,
    identifierStorageSchema: key.storageSchema,
    columns: compiledColumns(storedFields),
  }
})

export {
  compileTable,
  type IdentifierName,
  type IdentifierSchema,
  type RowSchema,
}
