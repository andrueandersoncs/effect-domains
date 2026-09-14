import {
  Array,
  Data,
  Effect,
  Equivalence,
  Function,
  HashMap,
  HashSet,
  Match,
  Option,
  Predicate,
  Record,
  Schema,
  SchemaAST,
  String,
  Struct,
  flow,
  pipe,
} from "effect"

import { DomainIdentifier, type StructSchema, UuidV7Schema } from "./domain.ts"
import { FieldIR, ScalarSchema, SchemaField, ownValue, scalarChecks, type ScalarF } from "./schema-field.ts"

const isTrue = (value: boolean) => value

const TableScalarSchema = Schema.Literals(["string", "integer", "number"])
const TableCheckValueSchema = Schema.Union([Schema.String, Schema.Number])
const TableCheckValuesSchema = Schema.Array(TableCheckValueSchema)
const UuidV7GenerationSchema = Schema.Literal("uuidv7")
const OptionalUuidV7GenerationSchema = Schema.Option(UuidV7GenerationSchema)

export class GreaterThan extends Schema.TaggedClass<GreaterThan>()("GreaterThan", {
  value: Schema.Number,
}) {}

export class GreaterThanOrEqualTo extends Schema.TaggedClass<GreaterThanOrEqualTo>()(
  "GreaterThanOrEqualTo",
  { value: Schema.Number },
) {}

export class LessThan extends Schema.TaggedClass<LessThan>()("LessThan", {
  value: Schema.Number,
}) {}

export class LessThanOrEqualTo extends Schema.TaggedClass<LessThanOrEqualTo>()(
  "LessThanOrEqualTo",
  { value: Schema.Number },
) {}

export class OneOf extends Schema.TaggedClass<OneOf>()("OneOf", {
  values: TableCheckValuesSchema,
}) {}

export class MinLength extends Schema.TaggedClass<MinLength>()("MinLength", {
  value: Schema.Number,
}) {}

export class MaxLength extends Schema.TaggedClass<MaxLength>()("MaxLength", {
  value: Schema.Number,
}) {}

export const TableCheckSchema = Schema.Union([
  GreaterThan,
  GreaterThanOrEqualTo,
  LessThan,
  LessThanOrEqualTo,
  OneOf,
  MinLength,
  MaxLength,
])

export type TableCheck = Schema.Schema.Type<typeof TableCheckSchema>
const TableChecksSchema = Schema.Array(TableCheckSchema)

export class TableField extends Schema.TaggedClass<TableField>()("TableField", {
  name: Schema.String,
  scalar: TableScalarSchema,
  nullable: Schema.Boolean,
  generation: OptionalUuidV7GenerationSchema,
  checks: TableChecksSchema,
}) {}

type TableColumns<Fields extends Schema.Struct.Fields> = Readonly<{
  [K in Extract<keyof Fields, string>]: TableColumn
}>

const RelationFieldsSchema = Schema.Array(Schema.String)

export class TableUnique extends Schema.Class<TableUnique>("TableUnique")({
  name: Schema.String,
  fields: RelationFieldsSchema,
}) {}

class TableForeignKeyReference extends Schema.Class<TableForeignKeyReference>(
  "TableForeignKeyReference",
)({
  table: Schema.String,
  fields: RelationFieldsSchema,
}) {}

export class TableForeignKey extends Schema.Class<TableForeignKey>("TableForeignKey")({
  name: Schema.String,
  fields: RelationFieldsSchema,
  references: TableForeignKeyReference,
}) {}

export class TableIndex extends Schema.Class<TableIndex>("TableIndex")({
  name: Schema.String,
  fields: RelationFieldsSchema,
}) {}

const UniqueRelationsSchema = Schema.Array(TableUnique)
const ForeignKeyRelationsSchema = Schema.Array(TableForeignKey)
const IndexRelationsSchema = Schema.Array(TableIndex)
const OptionalUniqueRelationsSchema = Schema.optionalKey(UniqueRelationsSchema)
const OptionalForeignKeyRelationsSchema = Schema.optionalKey(ForeignKeyRelationsSchema)
const OptionalIndexRelationsSchema = Schema.optionalKey(IndexRelationsSchema)

class TableRelations extends Schema.Class<TableRelations>("TableRelations")({
  unique: OptionalUniqueRelationsSchema,
  foreignKeys: OptionalForeignKeyRelationsSchema,
  indexes: OptionalIndexRelationsSchema,
}) {}

type TableRelationFields<Fields extends string> = readonly Fields[]

interface TableReference {
  readonly table: Table
  readonly fields: ReadonlyArray<string>
}

export type TableRelationsInput<Fields extends string = string> = Readonly<Partial<{
  readonly unique: ReadonlyArray<
    Omit<TableUnique, "name" | "fields">
    & Partial<Pick<TableUnique, "name">>
    & { readonly fields: TableRelationFields<Fields> }
  >
  readonly foreignKeys: ReadonlyArray<
    Omit<TableForeignKey, "name" | "fields" | "references">
    & Partial<Pick<TableForeignKey, "name">>
    & Partial<Readonly<{ scope: TableRelationFields<Fields> }>>
    & {
      readonly fields: TableRelationFields<Fields>
      readonly references: TableReference
    }
  >
  readonly indexes: ReadonlyArray<
    Omit<TableIndex, "name" | "fields">
    & Partial<Pick<TableIndex, "name">>
    & { readonly fields: TableRelationFields<Fields> }
  >
}>>

const TableFieldsSchema = Schema.Array(TableField)
const OptionalTableRelationsSchema = Schema.optionalKey(TableRelations)

export class TableSnapshot extends Schema.Class<TableSnapshot>("TableSnapshot")({
  name: Schema.String,
  identifier: Schema.String,
  fields: TableFieldsSchema,
  relations: OptionalTableRelationsSchema,
}) {}

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

class TableDefinitionError extends Schema.TaggedError<TableDefinitionError>()(
  "TableDefinitionError",
  { table: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `Invalid table definition for ${this.table}: ${this.reason}`
  }
}

const failTableDefinition = (table: string, reason: string) =>
  pipe(TableDefinitionError.make({ table, reason }), Effect.fail)

const unsupportedTableScalar = (table: string, field: string) =>
  failTableDefinition(table, `field ${field} must encode to a supported scalar`)

const numericScalar = (scalar: TableField["scalar"]) => {
  const integer = Equivalence.strictEqual<TableField["scalar"]>()(scalar, "integer")
  const number = Equivalence.strictEqual<TableField["scalar"]>()(scalar, "number")
  return integer || number
}

const relationConstraints = (relations: TableRelations): ReadonlyArray<RelationConstraint> => {
  const unique = relations.unique ?? []
  const foreignKeys = relations.foreignKeys ?? []
  const indexes = relations.indexes ?? []
  const local = Array.appendAll(unique, foreignKeys)
  return Array.appendAll(local, indexes)
}

type RelationConstraint = TableUnique | TableForeignKey | TableIndex

const emptyNames = () => HashSet.empty<string>()

const validateConstraintFields = (
  table: string,
  name: string,
  fields: ReadonlyArray<string>,
  available: HashSet.HashSet<string>,
) => {
  const trimmedName = name.trim()
  const emptyName = Equivalence.strictEqual<number>()(trimmedName.length, 0)
  const emptyFields = Array.isReadonlyArrayEmpty(fields)

  if (emptyName) return failTableDefinition(table, "relation constraint name must not be empty")
  if (emptyFields) return failTableDefinition(table, `relation constraint ${name} must declare fields`)

  return Effect.reduce(
    fields,
    emptyNames,
    Effect.fn("Table.validateConstraintField")(function* (seen, field) {
      const known = HashSet.has(available, field)
      const duplicate = HashSet.has(seen, field)

      if (!known) return yield* failTableDefinition(table, `relation constraint ${name} declares unknown field ${field}`)
      if (duplicate) return yield* failTableDefinition(table, `relation constraint ${name} declares duplicate field ${field}`)

      return HashSet.add(seen, field)
    }),
  )
}

const validateConstraint = (table: string, available: HashSet.HashSet<string>) =>
  Effect.fn("Table.validateConstraint")(function* (names: HashSet.HashSet<string>, constraint: RelationConstraint) {
    const duplicate = HashSet.has(names, constraint.name)
    if (duplicate) return yield* failTableDefinition(table, `duplicate relation constraint name ${constraint.name}`)

    yield* validateConstraintFields(table, constraint.name, constraint.fields, available)
    return HashSet.add(names, constraint.name)
  })

const validateForeignKeyReference = (table: string) =>
  Effect.fn("Table.validateForeignKeyReference")(function* (foreignKey: TableForeignKey) {
    const referencedTable = foreignKey.references.table.trim()
    const emptyTable = Equivalence.strictEqual<number>()(referencedTable.length, 0)

    if (emptyTable) {
      return yield* failTableDefinition(
        table,
        `foreign key constraint ${foreignKey.name} references an empty table`,
      )
    }


    const referenceNames = HashSet.fromIterable(foreignKey.references.fields)
    yield* validateConstraintFields(table, foreignKey.name, foreignKey.references.fields, referenceNames)
  })

const hasReservedIndexPrefix = (index: TableIndex) =>
  index.name.toLowerCase().startsWith("sqlite_")

const validateReservedIndex = (table: string) => (index: TableIndex) =>
  hasReservedIndexPrefix(index)
    ? failTableDefinition(table, `index constraint ${index.name} uses the reserved sqlite_ prefix`)
    : Effect.void

const validateLocalRelations = (
  table: string,
  fields: ReadonlyArray<TableField>,
  relations: Option.Option<TableRelations>,
) => pipe(
  relations,
  Option.match({
    onNone: Function.constant(Effect.void),
    onSome: Effect.fn("Table.validateLocalRelations")(function* (value) {
      const fieldNames = Array.map(fields, Struct.get("name"))
      const available = HashSet.fromIterable(fieldNames)
      const constraints = relationConstraints(value)
      yield* Effect.reduce(constraints, emptyNames, validateConstraint(table, available))
      yield* Effect.forEach(value.foreignKeys ?? [], validateForeignKeyReference(table))
      yield* Effect.forEach(value.indexes ?? [], validateReservedIndex(table))
    }),
  }),
)

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

  return pipe(Match.value(layer), Match.tagsExhaustive({
    Leaf: ({ ast }) => leaf(ast),
    Unsupported: () => unsupportedTableScalar(table, field),
    Collection: () => unsupportedTableScalar(table, field),
    Encoding: ({ value }) => pipe(value, Effect.map((encoded) => new ScalarCompilation({ ...encoded, orderable: false }))),
    Suspend: ({ value }) => pipe(value, Effect.map((inner) => new ScalarCompilation({ ...inner, checks: [...checks, ...inner.checks] }))),
    Union: Effect.fn("Table.union")(function* ({ members: children }: Extract<ScalarF<Effect.Effect<ScalarCompilation, TableDefinitionError>>, { readonly _tag: "Union" }>) {
      const members = yield* Effect.all(children)
      const hasScalar = (member: ScalarCompilation) => Option.isSome(member.scalar)
      const physical = Array.filter(members, hasScalar)
      const head = Array.head(physical)
      if (Option.isNone(head)) return yield* unsupportedTableScalar(table, field)
      const first = Option.getOrThrow(head)
      const sameScalar = (member: ScalarCompilation) => Option.makeEquivalence(Equivalence.strictEqual<TableField["scalar"]>())(member.scalar, first.scalar)
      const isNumeric = (member: ScalarCompilation) => Option.exists(member.scalar, numericScalar)
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
    }),
  }))
}

const compileScalar = (table: string, field: string, ast: SchemaAST.AST) =>
  ScalarSchema.fold("storage", scalarAlgebra(table, field))(ast)

interface TableColumn {
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
  const value = pipe(Option.fromNullishOr(annotations), Option.map((all) => all[DomainIdentifier]))
  const booleanValue = pipe(value, Option.filter(Predicate.isBoolean))
  return pipe(booleanValue, Option.exists(isTrue))
}

const sourceField = <S extends StructSchema>(schema: S) => (name: string) =>
  Option.fromNullishOr(schema.fields[name as Extract<keyof S["fields"], string>])

const compileField = <S extends StructSchema>(table: string, schema: S) =>
  Effect.fn("Table.compileField")(function* (property: SchemaAST.PropertySignature) {
    const stringName = Predicate.isString(property.name)
    if (!stringName) return yield* failTableDefinition(table, "field names must be strings")

    const optional = SchemaAST.isOptional(property.type)
    if (optional) return yield* failTableDefinition(table, `field ${property.name} must be required`)

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
  if (!flat) return yield* failTableDefinition(name, "schema must encode to a flat struct")

  const indexed = encodedSchema.ast.indexSignatures.length > 0
  if (indexed) return yield* failTableDefinition(name, "schema must not contain index signatures")

  const compiled = yield* Effect.forEach(encodedSchema.ast.propertySignatures, compileField(name, schema))
  const identifiers = Array.filter(compiled, compiledIdentifier(schema))
  const multipleIdentifiers = Array.length(identifiers) > 1
  if (multipleIdentifiers) return yield* failTableDefinition(name, "schema must contain at most one Domain.identifier field")

  const identifier = Array.head(identifiers)
  const nullableIdentifier = pipe(identifier, Option.filter((value) => value.field.nullable))

  if (Option.isSome(nullableIdentifier)) {
    return yield* failTableDefinition(
      name,
      `identifier field ${nullableIdentifier.value.field.name} must not encode to null`,
    )
  }

  const implicit = Option.isNone(identifier)
  const hasId = Array.some(compiled, namedIdentifierField)
  const ambiguousId = implicit && hasId
  if (ambiguousId) {
    return yield* failTableDefinition(
      name,
      "field id must use Domain.identifier when overriding the default UUIDv7 identifier",
    )
  }

  const rowSchema = implicit ? withImplicitIdentifier(schema) : schema

  const key = pipe(identifier, Option.getOrElse(() => new CompiledField({
    field: DefaultIdentifierField,
    storageSchema: UuidV7Schema,
    orderable: true,
    canonical: SchemaField.compile(UuidV7Schema),
    transformsStoredNull: SchemaField.transformsStoredNull(UuidV7Schema.ast),
  })))

  const storedFields = implicit ? Array.prepend(compiled, key) : compiled
  const identifierSchema = pipe(sourceField(rowSchema)(key.field.name), Option.getOrThrow)
  const insertSchema = compileStorageSchema(schema, compiled)
  const storageSchema = implicit ? compileStorageSchema(rowSchema, storedFields) : insertSchema

  return {
    _tag: "Table" as const,
    name,
    schema,
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

type EncodedRecord = Readonly<Record<string, unknown>>
type InsertSchema<S extends StructSchema> = Schema.Codec<S["Type"], EncodedRecord, S["DecodingServices"], S["EncodingServices"]>
type StoredRowSchema<Row extends StructSchema> = Schema.Codec<Row["Type"], EncodedRecord, Row["DecodingServices"], Row["EncodingServices"]>
type IdentifierStorageSchema<Identifier extends Schema.Constraint> = Schema.Codec<Identifier["Type"], unknown, Identifier["DecodingServices"], Identifier["EncodingServices"]>

export interface Table<
  Name extends string = string,
  Row extends StructSchema = StructSchema,
  Insert extends Schema.Constraint = Schema.Codec<unknown, unknown, unknown, unknown>,
  Storage extends Schema.Constraint = Schema.Codec<unknown, unknown, unknown, unknown>,
  Key extends string = string,
  Identifier extends Schema.Constraint = Schema.Constraint,
  IdentifierStorage extends Schema.Constraint = Schema.Constraint,
  Columns extends Readonly<Record<string, TableColumn>> = Readonly<Record<string, TableColumn>>,
> extends Readonly<Partial<{ relations: TableRelations }>> {
  readonly _tag: "Table"
  readonly name: Name
  readonly schema: StructSchema
  readonly rowSchema: Row
  readonly insertSchema: Insert
  readonly storageSchema: Storage
  readonly identifier: Key
  readonly identifierSchema: Identifier
  readonly identifierStorageSchema: IdentifierStorage
  readonly fields: ReadonlyArray<TableField>
  readonly columns: Columns
  readonly relationTargets: ReadonlyArray<Table>
}

export type TableFieldName<S extends StructSchema> = Extract<keyof RowSchema<S>["fields"], string>

// Derive snake_case names because the hand-written histories already follow SQL convention.
const constraintName = (table: string, fields: ReadonlyArray<string>, suffix: string) => {
  const segments = Array.map(fields, String.camelToSnake)
  const joined = Array.join(segments, "_")
  return `${table}_${joined}_${suffix}`
}

const cloneRelations = <Fields extends string>(table: string, relations: TableRelationsInput<Fields>) => {
  const unique = pipe(
    Option.fromNullishOr(relations.unique),
    Option.map(Array.map((constraint) => {
      const name = pipe(
        Option.fromNullishOr(constraint.name),
        Option.getOrElse(() => constraintName(table, constraint.fields, "key")),
      )

      return TableUnique.make({ name, fields: constraint.fields })
    })),
  )

  const foreignKeys = pipe(
    Option.fromNullishOr(relations.foreignKeys),
    Option.map(Array.map((constraint) => {
      const scope = pipe(Option.fromNullishOr(constraint.scope), Option.getOrElse(Array.empty))
      const fields = Array.appendAll(scope, constraint.fields)
      const referenced = Array.appendAll(scope, constraint.references.fields)

      const name = pipe(
        Option.fromNullishOr(constraint.name),
        Option.getOrElse(() => constraintName(table, fields, "fkey")),
      )

      const references = TableForeignKeyReference.make({ table: constraint.references.table.name, fields: referenced })
      return TableForeignKey.make({ name, fields, references })
    })),
  )

  const indexes = pipe(
    Option.fromNullishOr(relations.indexes),
    Option.map(Array.map((constraint) => {
      const name = pipe(
        Option.fromNullishOr(constraint.name),
        Option.getOrElse(() => constraintName(table, constraint.fields, "idx")),
      )

      return TableIndex.make({ name, fields: constraint.fields })
    })),
  )

  return TableRelations.make(Record.getSomes({ unique, foreignKeys, indexes }))
}

const foreignKeyTarget = flow(
  Struct.get<{ readonly references: TableReference }, "references">("references"),
  Struct.get<TableReference, "table">("table"),
)

const make = <const Name extends string, const S extends StructSchema>(
  options: Readonly<{ name: Name; schema: S }> & Readonly<Partial<{ relations: TableRelationsInput<TableFieldName<S>> }>>,
): Table<Name, RowSchema<S>, InsertSchema<S>, StoredRowSchema<RowSchema<S>>, [IdentifierName<S>] extends [never] ? "id" : IdentifierName<S>, IdentifierSchema<S>, IdentifierStorageSchema<IdentifierSchema<S>>, TableColumns<RowSchema<S>["fields"]>> => {
  const compilation = compileTable(options.name, options.schema)
  const result = Effect.runSync(compilation)
  const relations = Option.fromNullishOr(options.relations)

  const relationTargets = pipe(
    relations,
    Option.flatMap(flow(Struct.get("foreignKeys"), Option.fromNullishOr)),
    Option.map(Array.map(foreignKeyTarget)),
    Option.map(Array.dedupeWith(Equivalence.strictEqual<Table>())),
    Option.getOrElse((): ReadonlyArray<Table> => []),
  )

  const copiedRelations = pipe(relations, Option.map((value) => cloneRelations(result.name, value)))

  const validation = pipe(copiedRelations, Option.match({
    onNone: Function.constant(Effect.void),
    onSome: (value) => {
      const localRelations = Option.some(value)
      return validateLocalRelations(result.name, result.fields, localRelations)
    },
  }))

  Effect.runSync(validation)

  const withTargets = Struct.assign(result, { relationTargets })

  return pipe(copiedRelations, Option.match({
    onNone: Function.constant(withTargets),
    onSome: (value) => Struct.assign(withTargets, { relations: value }),
  })) as typeof result & Table<Name, RowSchema<S>, InsertSchema<S>, StoredRowSchema<RowSchema<S>>, [IdentifierName<S>] extends [never] ? "id" : IdentifierName<S>, IdentifierSchema<S>, IdentifierStorageSchema<IdentifierSchema<S>>, TableColumns<RowSchema<S>["fields"]>>
}

const isOneOfCheck = (check: TableCheck): check is OneOf =>
  Equivalence.strictEqual<TableCheck["_tag"]>()(check._tag, "OneOf")

// Decode the physical model because native Schema traversal copies nested arrays and classes.
const snapshot = (table: Table) => pipe(
  table,
  Struct.pick(["name", "identifier", "fields", "relations"]),
  Schema.decodeUnknownEffect(TableSnapshot),
  Effect.runSync,
)

const fieldsEqual = Equivalence.Array(Equivalence.strictEqual<string>())

const compatibleForeignKeyScalars = (source: TableField["scalar"], target: TableField["scalar"]) => {
  const same = Equivalence.strictEqual<TableField["scalar"]>()(source, target)
  const numeric = numericScalar(source) && numericScalar(target)
  return same || numeric
}

const tableEntry = (table: TableSnapshot) => [table.name, table] as const
const tableIndexPair = (table: TableSnapshot) => (index: TableIndex) => [table.name, index] as const

const tableIndexPairs = (table: TableSnapshot) =>
  Array.map(table.relations?.indexes ?? [], tableIndexPair(table))

const fieldEntry = (field: TableField) => [field.name, field] as const

const validateTable = Effect.fn("Table.validateTable")(function* (
  names: HashSet.HashSet<string>,
  table: TableSnapshot,
) {
  const normalized = table.name.toLowerCase()
  const duplicate = HashSet.has(names, normalized)
  if (duplicate) return yield* failTableDefinition(table.name, `duplicate table ${table.name}`)

  const relations = Option.fromNullishOr(table.relations)
  yield* validateLocalRelations(table.name, table.fields, relations)
  return HashSet.add(names, normalized)
})

const validateIndex = (tableNames: HashSet.HashSet<string>) =>
  Effect.fn("Table.validateIndex")(function* (
    indexNames: HashSet.HashSet<string>,
    entry: readonly [string, TableIndex],
  ) {
    const [table, index] = entry
    const normalized = index.name.toLowerCase()
    const tableCollision = HashSet.has(tableNames, normalized)
    const duplicate = HashSet.has(indexNames, normalized)

    if (tableCollision) return yield* failTableDefinition(table, `index constraint ${index.name} collides with a table name`)
    if (duplicate) return yield* failTableDefinition(table, `duplicate index constraint name ${index.name}`)

    return HashSet.add(indexNames, normalized)
  })

const uniqueFieldsEqual = (fields: ReadonlyArray<string>) => (unique: TableUnique) =>
  fieldsEqual(unique.fields, fields)

const validateForeignKeyPair = (
  table: TableSnapshot,
  foreignKey: TableForeignKey,
  sourceFields: HashMap.HashMap<string, TableField>,
  target: TableSnapshot,
  targetFields: HashMap.HashMap<string, TableField>,
) => Effect.fn("Table.validateForeignKeyPair")(function* (
  [sourceName, targetName]: readonly [string, string],
) {
  const source = HashMap.get(sourceFields, sourceName)
  const targetField = HashMap.get(targetFields, targetName)
  const fields = Option.all([source, targetField])

  if (Option.isNone(fields)) {
    return yield* failTableDefinition(
      table.name,
      `foreign key constraint ${foreignKey.name} references unknown field ${sourceName} or ${targetName}`,
    )
  }

  const [sourceField, referencedField] = fields.value
  const compatible = compatibleForeignKeyScalars(sourceField.scalar, referencedField.scalar)

  if (!compatible) {
    return yield* failTableDefinition(
      table.name,
      `foreign key constraint ${foreignKey.name} has incompatible field types ${sourceName} and ${target.name}.${targetName}`,
    )
  }
})

const validateForeignKey = (
  tables: HashMap.HashMap<string, TableSnapshot>,
  table: TableSnapshot,
) => Effect.fn("Table.validateForeignKey")(function* (foreignKey: TableForeignKey) {
  const targetOption = HashMap.get(tables, foreignKey.references.table)

  if (Option.isNone(targetOption)) {
    return yield* failTableDefinition(
      table.name,
      `foreign key constraint ${foreignKey.name} references unknown table ${foreignKey.references.table}`,
    )
  }

  const arityMatches = Equivalence.strictEqual<number>()(
    foreignKey.fields.length,
    foreignKey.references.fields.length,
  )

  if (!arityMatches) {
    return yield* failTableDefinition(
      table.name,
      `foreign key constraint ${foreignKey.name} has incompatible source and target arity`,
    )
  }

  const target = Option.getOrThrow(targetOption)
  const targetIsIdentifier = fieldsEqual(foreignKey.references.fields, [target.identifier])
  const unique = target.relations?.unique ?? []
  const targetIsUnique = Array.some(unique, uniqueFieldsEqual(foreignKey.references.fields))
  const validTarget = targetIsIdentifier || targetIsUnique

  if (!validTarget) {
    return yield* failTableDefinition(
      table.name,
      `foreign key constraint ${foreignKey.name} must reference the primary key or a declared unique tuple of ${target.name}`,
    )
  }

  const sourceEntries = Array.map(table.fields, fieldEntry)
  const targetEntries = Array.map(target.fields, fieldEntry)
  const sourceFields = HashMap.fromIterable(sourceEntries)
  const targetFields = HashMap.fromIterable(targetEntries)
  const pairs = Array.zip(foreignKey.fields, foreignKey.references.fields)
  yield* Effect.forEach(pairs, validateForeignKeyPair(table, foreignKey, sourceFields, target, targetFields))
})

const validateForeignKeys = (tables: HashMap.HashMap<string, TableSnapshot>) => (table: TableSnapshot) =>
  Effect.forEach(table.relations?.foreignKeys ?? [], validateForeignKey(tables, table))

const validateRelations = Effect.fn("Table.validateRelations")(function* (
  tables: ReadonlyArray<TableSnapshot>,
) {
  const tableEntries = Array.map(tables, tableEntry)
  const byName = HashMap.fromIterable(tableEntries)
  const tableNames = yield* Effect.reduce(tables, emptyNames, validateTable)
  const indexes = Array.flatMap(tables, tableIndexPairs)
  yield* Effect.reduce(indexes, emptyNames, validateIndex(tableNames))
  yield* Effect.forEach(tables, validateForeignKeys(byName))
})

type ProjectedField<TableDefinition extends Table> = Extract<keyof TableDefinition["rowSchema"]["fields"], string>

const reference = <
  const Target extends Table,
  const Fields extends ReadonlyArray<Extract<keyof Target["rowSchema"]["fields"], string>>,
>(table: Target, fields: Fields): TableReference => {
  const copiedFields = Array.copy(fields)
  const frozenFields = Object.freeze(copiedFields)
  return Object.freeze({ table, fields: frozenFields })
}

const project = <
  const TableDefinition extends Table,
  const Fields extends ReadonlyArray<ProjectedField<TableDefinition>>,
>(table: TableDefinition, fields: Fields) => {
  const selection = Object.freeze([...fields])
  const selected = Struct.pick(table.columns, selection)
  const StorageSchema = Schema.Struct(Record.map(selected, Struct.get("storageSchema")))

  const ProjectionSchema = Schema.make<Schema.Codec<
    Pick<TableDefinition["rowSchema"]["Type"], Fields[number]>,
    Readonly<Record<Fields[number], unknown>>,
    TableDefinition["storageSchema"]["DecodingServices"],
    TableDefinition["storageSchema"]["EncodingServices"]
  >>(StorageSchema.ast)

  const object = (sql: import("effect/unstable/sql").SqlClient.SqlClient, alias: string) => {
    const entry = (field: Fields[number]) => sql`${field}, ${sql(alias)}.${sql(field)}`
    const entries = Array.map(selection, entry)
    return sql`json_object(${sql.csv(entries)})`
  }

  return {
    fields: selection,
    schema: ProjectionSchema,
    json: Schema.fromJsonString(ProjectionSchema),
    object,
  }
}

export const Table = { make, reference, project, snapshot, validateRelations }
