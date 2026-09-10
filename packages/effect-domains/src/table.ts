import {
  Array,
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
  Struct,
  flow,
  pipe,
} from "effect"

import { DomainIdentifier, type StructSchema } from "./domain.ts"

const isTrue = (value: boolean) => value

const UuidV7Check = Schema.isUUID(7)
export const DefaultTableIdentifierSchema = Schema.String.check(UuidV7Check)
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

const TableColumnSchema = Schema.Struct({
  storageSchema: Schema.Unknown,
  orderable: Schema.Boolean,
})

interface TableColumn extends Schema.Schema.Type<typeof TableColumnSchema> {
  readonly storageSchema: Schema.Constraint
}

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

export type TableRelationsInput<Fields extends string = string> = Readonly<Partial<{
  unique: readonly Readonly<Pick<TableUnique, "name"> & { fields: TableRelationFields<Fields> }>[]
  foreignKeys: readonly Readonly<Pick<TableForeignKey, "name"> & {
    fields: TableRelationFields<Fields>
    references: Readonly<Pick<TableForeignKey["references"], "table"> & { fields: readonly string[] }>
  }>[]
  indexes: readonly Readonly<Pick<TableIndex, "name"> & { fields: TableRelationFields<Fields> }>[]
}>>

const TableFieldsSchema = Schema.Array(TableField)
const OptionalTableRelationsSchema = Schema.optionalKey(TableRelations)

export class TableSnapshot extends Schema.Class<TableSnapshot>("TableSnapshot")({
  name: Schema.String,
  identifier: Schema.String,
  fields: TableFieldsSchema,
  relations: OptionalTableRelationsSchema,
}) {}

const DefaultIdentifierFields = Record.singleton("id", DefaultTableIdentifierSchema)
const NoGeneration = Option.none<"uuidv7">()
const GeneratedIdentifierGeneration = Option.some<"uuidv7">("uuidv7")
const NoTableChecks: ReadonlyArray<TableCheck> = []

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

const foreignKeysFor = (relations: Option.Option<TableRelations>) => pipe(
  relations,
  Option.match({ onNone: Function.constant([]), onSome: (value) => value.foreignKeys ?? [] }),
)

const indexesFor = (relations: Option.Option<TableRelations>) => pipe(
  relations,
  Option.match({ onNone: Function.constant([]), onSome: (value) => value.indexes ?? [] }),
)

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

const descriptorValue = (descriptor: PropertyDescriptor) =>
  Option.fromNullishOr(descriptor.value)

const ownValue = (value: unknown, key: string) => {
  const descriptor = Predicate.isObject(value) ? Object.getOwnPropertyDescriptor(value, key) : null
  const option = Option.fromNullishOr(descriptor)
  return pipe(option, Option.flatMap(descriptorValue))
}

const representationId = (value: unknown) =>
  pipe(ownValue(value, "id"), Option.filter(Predicate.isString))

const DateTimeUtcId = "effect/schema/DateTimeUtc"
const IntegerId = "effect/schema/isInt"

const isDateTimeUtc = (ast: SchemaAST.AST) => {
  const representation = ast.annotations?.representation
  const id = representationId(representation)
  const matchesDateTimeUtc = (value: string) => Equivalence.strictEqual<string>()(value, DateTimeUtcId)
  return pipe(id, Option.exists(matchesDateTimeUtc))
}

type AstCheck = SchemaAST.Filter<unknown> | SchemaAST.FilterGroup<unknown>

const isFilterGroup = (check: AstCheck): check is SchemaAST.FilterGroup<unknown> =>
  Equivalence.strictEqual<AstCheck["_tag"]>()(check._tag, "FilterGroup")

const integerCheck = (check: AstCheck) => {
  if (isFilterGroup(check)) return pipe(check.checks, Array.some(integerCheck))

  const representation = check.annotations?.representation
  const id = representationId(representation)
  const matchesInteger = (value: string) => Equivalence.strictEqual<string>()(value, IntegerId)
  return pipe(id, Option.exists(matchesInteger))
}

const scalarForNumber = (value: number): TableField["scalar"] =>
  Number.isSafeInteger(value) ? "integer" : "number"

const commonScalar = (
  table: string,
  field: string,
  scalars: ReadonlyArray<TableField["scalar"]>,
) => {
  const unsupported = unsupportedTableScalar(table, field)

  return pipe(
    scalars,
    Array.head,
    Option.match({
      onNone: Function.constant(unsupported),
      onSome: (first) => {
        const sameFirst = (value: TableField["scalar"]) =>
          Equivalence.strictEqual<TableField["scalar"]>()(value, first)

        const uniform = pipe(scalars, Array.every(sameFirst))
        const numeric = pipe(scalars, Array.every(numericScalar))

        if (uniform) return Effect.succeed(first)
        return numeric ? Effect.succeed("number" as const) : unsupported
      },
    }),
  )
}

const suspendSeen = (seen: HashSet.HashSet<SchemaAST.AST>, ast: SchemaAST.AST) =>
  HashSet.has(seen, ast)

const nextSeen = (seen: HashSet.HashSet<SchemaAST.AST>, ast: SchemaAST.AST) =>
  HashSet.add(seen, ast)

const enumScalar = (value: string | number) =>
  Predicate.isString(value) ? "string" as const : scalarForNumber(value)

const enumEntryScalar = ([, value]: readonly [string, string | number]) =>
  enumScalar(value)

const stringScalarEffect = Effect.succeed("string" as const)
const integerScalarEffect = Effect.succeed("integer" as const)

const isNotNull = (member: SchemaAST.AST) => !SchemaAST.isNull(member)

const classifyScalar = (
  table: string,
  field: string,
  ast: SchemaAST.AST,
  seen: HashSet.HashSet<SchemaAST.AST> = HashSet.empty(),
): Effect.Effect<TableField["scalar"], TableDefinitionError> => {
  const unsupported = () => unsupportedTableScalar(table, field)

  const classifyDeclaration = (declaration: SchemaAST.Declaration) =>
    isDateTimeUtc(declaration) ? stringScalarEffect : unsupported()

  const classifyLiteral = (literal: unknown) => pipe(
    Match.value(literal),
    Match.when(Predicate.isString, Function.constant(stringScalarEffect)),
    Match.when(Predicate.isNumber, flow(scalarForNumber, Effect.succeed)),
    Match.orElse(unsupported),
  )

  return pipe(
    Match.value(ast),
    Match.when(SchemaAST.isSuspend, (suspended) => {
      const circular = suspendSeen(seen, suspended)
      if (circular) return unsupported()
      const resolved = suspended.thunk()
      const next = nextSeen(seen, suspended)
      return classifyScalar(table, field, resolved, next)
    }),
    Match.when(SchemaAST.isDeclaration, classifyDeclaration),
    Match.whenOr(SchemaAST.isString, SchemaAST.isTemplateLiteral, Function.constant(stringScalarEffect)),
    Match.when(SchemaAST.isNumber, (number) => {
      const checks = number.checks ?? []
      const integer = Array.some(checks, integerCheck)
      return Effect.succeed(integer ? "integer" as const : "number" as const)
    }),
    Match.when(SchemaAST.isBoolean, Function.constant(integerScalarEffect)),
    Match.when(SchemaAST.isLiteral, flow(Struct.get<SchemaAST.Literal, "literal">("literal"), classifyLiteral)),
    Match.when(SchemaAST.isEnum, (enumeration) => {
      const values = Array.map(enumeration.enums, enumEntryScalar)
      return commonScalar(table, field, values)
    }),
    Match.when(SchemaAST.isUnion, (union) => {
      const members = Array.map(union.types, classifyMember(table, field, seen))
      const classified = Effect.all(members)
      return pipe(classified, Effect.flatMap(commonScalarFor(table, field)))
    }),
    Match.orElse(unsupported),
  )
}

const classifyMember = (table: string, field: string, seen: HashSet.HashSet<SchemaAST.AST>) =>
  (member: SchemaAST.AST): Effect.Effect<TableField["scalar"], TableDefinitionError> =>
    classifyScalar(table, field, member, seen)

const commonScalarFor = (table: string, field: string) =>
  (scalars: ReadonlyArray<TableField["scalar"]>) => commonScalar(table, field, scalars)

const normalizedSuspend = (
  ast: SchemaAST.AST,
  seen: HashSet.HashSet<SchemaAST.AST> = HashSet.empty(),
): Option.Option<SchemaAST.AST> => {
  if (!SchemaAST.isSuspend(ast)) return Option.some(ast)

  const circular = suspendSeen(seen, ast)
  if (circular) return Option.none()

  const resolved = ast.thunk()
  const next = nextSeen(seen, ast)
  return normalizedSuspend(resolved, next)
}

const withoutNull = (ast: SchemaAST.AST): readonly [SchemaAST.AST, boolean] => {
  const union = SchemaAST.isUnion(ast)
  if (!union) return [ast, false]

  const nonNull = Array.filter(ast.types, isNotNull)
  const originalLength = Array.length(ast.types)
  const nonNullLength = Array.length(nonNull)
  const noNulls = Equivalence.strictEqual<number>()(originalLength, nonNullLength)
  const noMembers = Array.isReadonlyArrayEmpty(nonNull)
  const unchanged = noNulls || noMembers
  const exactlyOne = Equivalence.strictEqual<number>()(nonNullLength, 1)
  const nonNullHead = Array.head(nonNull)
  const first = pipe(nonNullHead, Option.getOrElse(Function.constant(ast)))
  const physical = exactlyOne ? first : new SchemaAST.Union(nonNull, ast.mode)
  return unchanged ? [ast, false] : [physical, true]
}

const scalarAst = (
  ast: SchemaAST.AST,
  seen: HashSet.HashSet<SchemaAST.AST> = HashSet.empty(),
  nullable = false,
): Option.Option<readonly [SchemaAST.AST, boolean]> => {
  const circular = suspendSeen(seen, ast)
  const next = nextSeen(seen, ast)

  if (circular) return Option.none()

  if (SchemaAST.isSuspend(ast)) {
    const resolved = ast.thunk()
    return scalarAst(resolved, next, nullable)
  }

  const [physical, containsNull] = withoutNull(ast)

  return containsNull
    ? scalarAst(physical, next, true)
    : Option.some([physical, nullable])
}

const physicalScalar = Effect.fn("Table.physicalScalar")(function* (
  table: string,
  field: string,
  ast: SchemaAST.AST,
) {
  const physicalOption = scalarAst(ast)
  if (Option.isNone(physicalOption)) return yield* unsupportedTableScalar(table, field)

  const [physicalAst, nullable] = physicalOption.value
  const scalar = yield* classifyScalar(table, field, physicalAst)
  return [physicalAst, scalar, nullable] as const
})

const flattenChecks = (check: AstCheck): ReadonlyArray<SchemaAST.Filter<unknown>> =>
  isFilterGroup(check) ? Array.flatMap(check.checks, flattenChecks) : [check]

const numberAt = (value: unknown, key: string) =>
  pipe(ownValue(value, key), Option.filter(Predicate.isNumber))

const flagAt = (value: unknown, key: string) => {
  const flag = ownValue(value, key)
  const booleanFlag = pipe(flag, Option.filter(Predicate.isBoolean))
  return pipe(booleanFlag, Option.exists(isTrue))
}

const greaterThan = (value: number): TableCheck => GreaterThan.make({ value })
const greaterThanOrEqualTo = (value: number): TableCheck => GreaterThanOrEqualTo.make({ value })
const lessThan = (value: number): TableCheck => LessThan.make({ value })
const lessThanOrEqualTo = (value: number): TableCheck => LessThanOrEqualTo.make({ value })

const checkFor = (payload: unknown, key: string, make: (value: number) => TableCheck) =>
  pipe(
    numberAt(payload, key),
    Option.match({
      onNone: Function.constant(NoTableChecks),
      onSome: (number) => [make(number)],
    }),
  )

const betweenChecks = (payload: unknown): ReadonlyArray<TableCheck> => {
  const minimum = numberAt(payload, "minimum")
  const maximum = numberAt(payload, "maximum")
  const limits = Option.all([minimum, maximum])

  return pipe(limits, Option.match({
    onNone: Function.constant(NoTableChecks),
    onSome: ([lower, upper]) => {
      const exclusiveMinimum = flagAt(payload, "exclusiveMinimum")
      const exclusiveMaximum = flagAt(payload, "exclusiveMaximum")
      const lowerCheck = exclusiveMinimum ? greaterThan(lower) : greaterThanOrEqualTo(lower)
      const upperCheck = exclusiveMaximum ? lessThan(upper) : lessThanOrEqualTo(upper)
      return [lowerCheck, upperCheck]
    },
  }))
}

const comparisonChecks = (id: string, payload: unknown): ReadonlyArray<TableCheck> => pipe(
  Match.value(id),
  Match.when("effect/schema/isGreaterThan", () => checkFor(payload, "exclusiveMinimum", greaterThan)),
  Match.when(
    "effect/schema/isGreaterThanOrEqualTo",
    () => checkFor(payload, "minimum", greaterThanOrEqualTo),
  ),
  Match.when("effect/schema/isLessThan", () => checkFor(payload, "exclusiveMaximum", lessThan)),
  Match.when(
    "effect/schema/isLessThanOrEqualTo",
    () => checkFor(payload, "maximum", lessThanOrEqualTo),
  ),
  Match.when("effect/schema/isBetween", () => betweenChecks(payload)),
  Match.orElse(Function.constant(NoTableChecks)),
)

const filterChecks = (filter: SchemaAST.Filter<unknown>): ReadonlyArray<TableCheck> => {
  const representation = filter.annotations?.representation
  const id = representationId(representation)
  const payload = ownValue(representation, "payload")
  const missingRepresentation = Option.isNone(id) || Option.isNone(payload)
  return missingRepresentation ? NoTableChecks : comparisonChecks(id.value, payload.value)
}

const tableChecksFromAst = (ast: SchemaAST.AST) => {
  const groups = ast.checks ?? []
  const filters = Array.flatMap(groups, flattenChecks)
  return Array.flatMap(filters, filterChecks)
}

const enumEntryValue = ([, value]: readonly [string, string | number]) => value

const literalScalars = (value: unknown) => pipe(
  Match.value(value),
  Match.whenOr(Predicate.isString, Predicate.isNumber, flow(Array.of<string | number>, Option.some)),
  Match.orElse(Option.none<ReadonlyArray<string | number>>),
)

const literalValues = (ast: SchemaAST.AST): Option.Option<ReadonlyArray<string | number>> => {
  const normalized = normalizedSuspend(ast)
  if (Option.isNone(normalized)) return Option.none()

  return pipe(
    Match.value(normalized.value),
    Match.when(SchemaAST.isLiteral, flow(Struct.get<SchemaAST.Literal, "literal">("literal"), literalScalars)),
    Match.when(SchemaAST.isEnum, flow(Struct.get<SchemaAST.Enum, "enums">("enums"), Array.map(enumEntryValue), Option.some)),
    Match.when(SchemaAST.isUnion, (union) => {
      const members = Array.map(union.types, literalValues)
      const values = Option.all(members)
      return pipe(values, Option.map(Array.flatten))
    }),
    Match.orElse(() => Option.none()),
  )
}

const tableChecks = (encodedAst: SchemaAST.AST, physicalAst: SchemaAST.AST) => {
  const direct = tableChecksFromAst(encodedAst)
  const sameAst = Equivalence.strictEqual<SchemaAST.AST>()(encodedAst, physicalAst)
  const physical = tableChecksFromAst(physicalAst)
  const checks = sameAst ? direct : Array.appendAll(direct, physical)
  const values = literalValues(physicalAst)

  return pipe(values, Option.match({
    onNone: Function.constant(checks),
    onSome: (oneOfValues) => {
      const oneOf = OneOf.make({ values: oneOfValues })
      return Array.append(checks, oneOf)
    },
  }))
}

const primitiveOrderable = (ast: SchemaAST.AST) => {
  const string = SchemaAST.isString(ast)
  const templateLiteral = SchemaAST.isTemplateLiteral(ast)
  const number = SchemaAST.isNumber(ast)
  const boolean = SchemaAST.isBoolean(ast)
  const literal = SchemaAST.isLiteral(ast)
  const enumeration = SchemaAST.isEnum(ast)
  return Array.some([string, templateLiteral, number, boolean, literal, enumeration], Boolean)
}

const orderableAst = (ast: SchemaAST.AST): boolean => {
  const unencoded = !Boolean(ast.encoding)

  const normalizedOrderable = (value: SchemaAST.AST) => {
    const plain = !Boolean(value.encoding)

    return plain && pipe(
      Match.value(value),
      Match.when(SchemaAST.isUnion, flow(Struct.get<SchemaAST.Union, "types">("types"), Array.every(orderableAst))),
      Match.orElse(primitiveOrderable),
    )
  }

  return unencoded && pipe(normalizedSuspend(ast), Option.exists(normalizedOrderable))
}

const NullableDateTimeUtcFromStringSchema = Schema.NullOr(Schema.DateTimeUtcFromString)
const NullableBooleanFromBitSchema = Schema.NullOr(Schema.BooleanFromBit)

const nativeStorageAst = (ast: SchemaAST.AST) => {
  const boolean = SchemaAST.isBoolean(ast)
  const dateTime = isDateTimeUtc(ast)
  return boolean || dateTime
}

const storageFieldFor = Effect.fn("Table.storageFieldFor")(function* (
  table: string,
  field: string,
  schema: Schema.Constraint,
) {
  const encodedSchema = Schema.toEncoded(schema)
  const [encodedAst, scalar, nullable] = yield* physicalScalar(table, field, encodedSchema.ast)
  const native = nativeStorageAst(encodedAst)

  if (!native) return [schema, encodedSchema, scalar, nullable, encodedAst] as const
  const typeAst = SchemaAST.toType(schema.ast)
  const [decodedAst, , decodedNullable] = yield* physicalScalar(table, field, typeAst)
  const decodedNative = nativeStorageAst(decodedAst)
  if (!decodedNative) return yield* unsupportedTableScalar(table, field)

  const dateTime = isDateTimeUtc(decodedAst)
  const nullableSchema = dateTime ? NullableDateTimeUtcFromStringSchema : NullableBooleanFromBitSchema
  const requiredSchema = dateTime ? Schema.DateTimeUtcFromString : Schema.BooleanFromBit
  const storageRepresentationSchema = decodedNullable ? nullableSchema : requiredSchema
  const decodeToStorage = Schema.decodeTo(schema)
  const storedSchema = decodeToStorage(storageRepresentationSchema)
  const storedEncodedSchema = Schema.toEncoded(storedSchema)
  const [storedAst, storedScalar, storedNullable] = yield* physicalScalar(table, field, storedEncodedSchema.ast)
  return [storedSchema, storedEncodedSchema, storedScalar, storedNullable, storedAst] as const
}
)

const CompiledFieldSchema = Schema.Struct({
  field: TableField,
  storageSchema: Schema.Unknown,
  orderable: Schema.Boolean,
})

interface CompiledField extends Schema.Schema.Type<typeof CompiledFieldSchema> {
  readonly storageSchema: Schema.Constraint
}

const makeCompiledField = (field: TableField, storageSchema: Schema.Constraint, orderable: boolean) =>
  CompiledFieldSchema.make({ field, storageSchema, orderable }) as CompiledField

const storageFieldEntry = (compiled: CompiledField) =>
  [compiled.field.name, compiled.storageSchema] as const

const compiledFieldEntry = (compiled: CompiledField) =>
  [compiled.field.name, TableColumnSchema.make({ storageSchema: compiled.storageSchema, orderable: compiled.orderable })] as const

const compileStorageSchema = (schema: StructSchema, fields: ReadonlyArray<CompiledField>) => {
  const entries = Array.map(fields, storageFieldEntry)
  const storageFields = Record.fromEntries(entries)
  const StoredRowSchema = Schema.Struct(storageFields)
  interface StoredRow extends Schema.Schema.Type<typeof StoredRowSchema> {}
  const typeAst = SchemaAST.toType(schema.ast)
  const checks = Option.fromNullishOr(typeAst.checks)

  return pipe(checks, Option.match({
    onNone: Function.constant(StoredRowSchema),
    onSome: (value) => StoredRowSchema.check(...value),
  }))
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
    const [storageSchema, encodedSchema, scalar, nullable, physicalAst] = yield* storageFieldFor(table, property.name, fieldSchema)
    const checks = tableChecks(encodedSchema.ast, physicalAst)
    const field = TableField.make({ name: property.name, scalar, nullable, generation: NoGeneration, checks })
    const orderable = orderableAst(fieldSchema.ast)
    return makeCompiledField(field, storageSchema, orderable)
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

  if (Option.isSome(identifier)) {
    const storedSchema = compileStorageSchema(schema, compiled)
    const identifierField = sourceField(schema)(identifier.value.field.name)
    const identifierSchema = Option.getOrThrow(identifierField)

    return {
      name,
      schema,
      rowSchema: schema,
      identifier: identifier.value.field.name,
      identifierSchema,
      fields: compiledFields(compiled),
      insertSchema: storedSchema,
      storageSchema: storedSchema,
      identifierStorageSchema: identifier.value.storageSchema,
      columns: compiledColumns(compiled),
    }
  }

  const hasId = Array.some(compiled, namedIdentifierField)

  if (hasId) {
    return yield* failTableDefinition(
      name,
      "field id must use Domain.identifier when overriding the default UUIDv7 identifier",
    )
  }

  const rowSchema = withImplicitIdentifier(schema)
  const [defaultStorageSchema] = yield* storageFieldFor(name, "id", rowSchema.fields.id)
  const defaultField = makeCompiledField(DefaultIdentifierField, defaultStorageSchema, true)
  const storedFields = Array.prepend(compiled, defaultField)
  const insertSchema = compileStorageSchema(schema, compiled)
  const storageSchema = compileStorageSchema(rowSchema, storedFields)
  const columns = compiledColumns(storedFields)

  return {
    name,
    schema,
    rowSchema,
    identifier: "id" as const,
    identifierSchema: rowSchema.fields.id,
    fields: compiledFields(storedFields),
    insertSchema,
    storageSchema,
    identifierStorageSchema: defaultStorageSchema,
    columns,
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
}

export type TableFieldName<S extends StructSchema> = Extract<keyof RowSchema<S>["fields"], string>

const cloneUnique = (value: TableUnique) =>
  TableUnique.make({ name: value.name, fields: Array.fromIterable(value.fields) })

const cloneForeignKey = (value: TableForeignKey) => {
  const reference = TableForeignKeyReference.make({
    table: value.references.table,
    fields: Array.fromIterable(value.references.fields),
  })

  return TableForeignKey.make({
    name: value.name,
    fields: Array.fromIterable(value.fields),
    references: reference,
  })
}

const cloneIndex = (value: TableIndex) =>
  TableIndex.make({ name: value.name, fields: Array.fromIterable(value.fields) })

const addUniqueRelations = (relations: TableRelations, input: TableRelationsInput) => pipe(
  Option.fromNullishOr(input.unique),
  Option.match({
    onNone: Function.constant(relations),
    onSome: (value) => {
      const unique = Array.map(value, cloneUnique)
      return Struct.assign(relations, { unique })
    },
  }),
)

const addForeignKeyRelations = (relations: TableRelations, input: TableRelationsInput) => pipe(
  Option.fromNullishOr(input.foreignKeys),
  Option.match({
    onNone: Function.constant(relations),
    onSome: (value) => {
      const foreignKeys = Array.map(value, cloneForeignKey)
      return Struct.assign(relations, { foreignKeys })
    },
  }),
)

const addIndexRelations = (relations: TableRelations, input: TableRelationsInput) => pipe(
  Option.fromNullishOr(input.indexes),
  Option.match({
    onNone: Function.constant(relations),
    onSome: (value) => {
      const indexes = Array.map(value, cloneIndex)
      return Struct.assign(relations, { indexes })
    },
  }),
)

const cloneRelations = (input: TableRelationsInput): TableRelations => {
  const initial = TableRelations.make({})
  const unique = addUniqueRelations(initial, input)
  const foreignKeys = addForeignKeyRelations(unique, input)
  return addIndexRelations(foreignKeys, input)
}

const make = <const Name extends string, const S extends StructSchema>(
  options: Readonly<{ name: Name; schema: S }> & Readonly<Partial<{ relations: TableRelationsInput<TableFieldName<S>> }>>,
): Table<Name, RowSchema<S>, InsertSchema<S>, StoredRowSchema<RowSchema<S>>, [IdentifierName<S>] extends [never] ? "id" : IdentifierName<S>, IdentifierSchema<S>, IdentifierStorageSchema<IdentifierSchema<S>>, TableColumns<RowSchema<S>["fields"]>> => {
  const compilation = compileTable(options.name, options.schema)
  const result = Effect.runSync(compilation)
  const relations = Option.fromNullishOr(options.relations)
  const copiedRelations = pipe(relations, Option.map(cloneRelations))

  const validation = pipe(copiedRelations, Option.match({
    onNone: Function.constant(Effect.void),
    onSome: (value) => {
      const localRelations = Option.some(value)
      return validateLocalRelations(result.name, result.fields, localRelations)
    },
  }))

  Effect.runSync(validation)

  return pipe(copiedRelations, Option.match({
    onNone: Function.constant(result),
    onSome: (value) => Struct.assign(result, { relations: value }),
  })) as typeof result & Table<Name, RowSchema<S>, InsertSchema<S>, StoredRowSchema<RowSchema<S>>, [IdentifierName<S>] extends [never] ? "id" : IdentifierName<S>, IdentifierSchema<S>, IdentifierStorageSchema<IdentifierSchema<S>>, TableColumns<RowSchema<S>["fields"]>>
}

const isOneOfCheck = (check: TableCheck): check is OneOf =>
  Equivalence.strictEqual<TableCheck["_tag"]>()(check._tag, "OneOf")

const snapshotCheck = (check: TableCheck) =>
  isOneOfCheck(check)
    ? OneOf.make({ values: Array.fromIterable(check.values) })
    : check

const snapshotField = (field: TableField) => {
  const checks = Array.map(field.checks, snapshotCheck)

  return TableField.make({
    name: field.name,
    scalar: field.scalar,
    nullable: field.nullable,
    generation: field.generation,
    checks,
  })
}

const snapshot = (table: Table) => {
  const fields = Array.map(table.fields, snapshotField)
  const relations = Option.fromNullishOr(table.relations)
  const withoutRelations = TableSnapshot.make({ name: table.name, identifier: table.identifier, fields })

  return pipe(relations, Option.match({
    onNone: Function.constant(withoutRelations),
    onSome: (value) => TableSnapshot.make({ name: table.name, identifier: table.identifier, fields, relations: cloneRelations(value) }),
  }))
}

const fieldsEqual = Equivalence.Array(Equivalence.strictEqual<string>())

const compatibleForeignKeyScalars = (source: TableField["scalar"], target: TableField["scalar"]) => {
  const same = Equivalence.strictEqual<TableField["scalar"]>()(source, target)
  const numeric = numericScalar(source) && numericScalar(target)
  return same || numeric
}

const tableEntry = (table: TableSnapshot) => [table.name, table] as const
const tableIndexPair = (table: TableSnapshot) => (index: TableIndex) => [table.name, index] as const

const tableIndexPairs = (table: TableSnapshot) => pipe(
  Option.fromNullishOr(table.relations),
  indexesFor,
  Array.map(tableIndexPair(table)),
)

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

const validateTableForeignKeys = (
  tables: HashMap.HashMap<string, TableSnapshot>,
  table: TableSnapshot,
) => (foreignKeys: ReadonlyArray<TableForeignKey>) =>
  Effect.forEach(foreignKeys, validateForeignKey(tables, table))

const validateForeignKeys = (tables: HashMap.HashMap<string, TableSnapshot>) => (table: TableSnapshot) =>
  pipe(
    Option.fromNullishOr(table.relations),
    foreignKeysFor,
    validateTableForeignKeys(tables, table),
  )

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

export const Table = { make, snapshot, validateRelations }
