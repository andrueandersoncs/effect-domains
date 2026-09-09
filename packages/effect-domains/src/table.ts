import {
  Array,
  Effect,
  Equivalence,
  Function,
  HashSet,
  Match,
  Option,
  Predicate,
  Record,
  Schema,
  SchemaAST,
  Struct,
  pipe,
} from "effect"
import { DomainIdentifier } from "./domain.ts"

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

const TableFieldsSchema = Schema.Array(TableField)

export class TableSnapshot extends Schema.Class<TableSnapshot>("TableSnapshot")({
  name: Schema.String,
  identifier: Schema.String,
  fields: TableFieldsSchema,
}) {}

const DefaultIdentifierFields = Record.singleton(
  "id",
  DefaultTableIdentifierSchema,
)

const NoGeneration = Option.none<"uuidv7">()
const GeneratedIdentifierGeneration = Option.some<"uuidv7">("uuidv7")

const DefaultIdentifierField = TableField.make({
  name: "id",
  scalar: "string",
  nullable: false,
  generation: GeneratedIdentifierGeneration,
  checks: [],
})

export class TableDefinitionError extends Schema.TaggedError<TableDefinitionError>()(
  "TableDefinitionError",
  {
    table: Schema.String,
    reason: Schema.String,
  },
) {
  override get message() {
    return `Invalid table definition for ${this.table}: ${this.reason}`
  }
}

const failTableDefinition = (table: string, reason: string) =>
  pipe(
    TableDefinitionError.make({ table, reason }),
    Effect.fail,
  )

const unsupportedTableScalar = (table: string, field: string) =>
  failTableDefinition(table, `field ${field} must encode to a supported scalar`)

const tableScalarEquals = Equivalence.strictEqual<TableField["scalar"]>()

const tableScalarEqualsTo = (first: TableField["scalar"]) =>
  (scalar: TableField["scalar"]) => tableScalarEquals(first, scalar)

const isNumericTableScalar = (scalar: TableField["scalar"]) => {
  const integer = tableScalarEquals(scalar, "integer")
  const number = tableScalarEquals(scalar, "number")
  return integer || number
}

const commonTableScalarFor = (
  table: string,
  field: string,
  scalars: ReadonlyArray<TableField["scalar"]>,
) => (first: TableField["scalar"]) => {
  const same = Array.every(scalars, tableScalarEqualsTo(first))
  if (same) return Effect.succeed(first)

  const numeric = Array.every(scalars, isNumericTableScalar)
  return numeric
    ? Effect.succeed("number" as const)
    : unsupportedTableScalar(table, field)
}

const commonTableScalar = (
  table: string,
  field: string,
  scalars: ReadonlyArray<TableField["scalar"]>,
) => {
  const first = Array.head(scalars)
  return Option.match(first, {
    onNone: () => unsupportedTableScalar(table, field),
    onSome: commonTableScalarFor(table, field, scalars),
  })
}

const stringFromUnknown = (value: unknown) => {
  const some = Option.some(value)
  return Option.filter(some, Predicate.isString)
}

const representationId = (ast: SchemaAST.AST) => {
  const representation = Option.fromNullishOr(ast.annotations?.representation)
  return Option.flatMap(representation, (value) => {
    if (!Predicate.isObject(value)) {
      return Option.none<string>()
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, "id")
    const id = Option.fromNullishOr(descriptor?.value)
    return Option.flatMap(id, stringFromUnknown)
  })
}

const emptyId = Function.constant("")

const integerRepresentation = (
  check: SchemaAST.Filter<unknown> | SchemaAST.FilterGroup<unknown>,
) => {
  const representationIdOption = Option.fromNullishOr(check.annotations?.representation?.id)
  const representationIdValue = Option.getOrElse(representationIdOption, emptyId)
  return Equivalence.strictEqual<string>()(representationIdValue, "effect/schema/isInt")
}

const integerCheckInGroup: (
  group: SchemaAST.FilterGroup<unknown>,
) => boolean = (group) => Array.some(group.checks, integerCheck)

const integerCheck: (
  check: SchemaAST.Filter<unknown> | SchemaAST.FilterGroup<unknown>,
) => boolean = (check) =>
  pipe(
    Match.value(check),
    Match.when({ _tag: "FilterGroup" }, integerCheckInGroup),
    Match.orElse(integerRepresentation),
  )

const emptyChecks = Function.constant<ReadonlyArray<SchemaAST.Filter<unknown> | SchemaAST.FilterGroup<unknown>>>([])

const integerAst = (ast: SchemaAST.AST) => {
  const checksOption = Option.fromNullishOr(ast.checks)
  const checks = Option.getOrElse(checksOption, emptyChecks)
  return Array.some(checks, integerCheck)
}

const literalTableScalar = (
  table: string,
  field: string,
  literal: SchemaAST.LiteralValue,
) => {
  if (Predicate.isString(literal)) {
    return Effect.succeed("string" as const)
  }

  if (Predicate.isNumber(literal)) {
    const integerLiteral = Number.isSafeInteger(literal)
    return Effect.succeed(integerLiteral ? "integer" as const : "number" as const)
  }

  return unsupportedTableScalar(table, field)
}

const DateTimeUtcId = "effect/schema/DateTimeUtc"
const dateTimeUtcId = (id: string) => Equivalence.strictEqual<string>()(id, DateTimeUtcId)
const stringScalar = Effect.succeed("string" as const)
const integerScalar = Effect.succeed("integer" as const)
const numberScalar = Effect.succeed("number" as const)
const NullableDateTimeUtcFromStringSchema = Schema.NullOr(Schema.DateTimeUtcFromString)
const NullableBooleanFromBitSchema = Schema.NullOr(Schema.BooleanFromBit)
const NoTableChecks: ReadonlyArray<TableCheck> = []
const noTableChecks = Function.constant(NoTableChecks)
const noneLiteralValues = Option.none<ReadonlyArray<string | number>>()
const noLiteralValues = Function.constant(noneLiteralValues)
const trueFlag = (flag: unknown) => Equivalence.strictEqual<unknown>()(flag, true)
const enumValue = ([, value]: SchemaAST.Enum["enums"][number]) => value

const classifyEnumEntry = (
  [, value]: SchemaAST.Enum["enums"][number],
): TableField["scalar"] => {
  if (Predicate.isString(value)) {
    return "string"
  }

  const integerEnum = Number.isSafeInteger(value)
  return integerEnum ? "integer" : "number"
}

const nonNullAst = (member: SchemaAST.AST) => !SchemaAST.isNull(member)

const declarationTableScalar = (
  table: string,
  field: string,
) => (ast: SchemaAST.Declaration) => {
  const id = representationId(ast)
  const utc = Option.exists(id, dateTimeUtcId)
  return utc ? stringScalar : unsupportedTableScalar(table, field)
}

const numberTableScalar = (ast: SchemaAST.Number) =>
  integerAst(ast) ? integerScalar : numberScalar

const literalTableScalarFor = (table: string, field: string) => (ast: SchemaAST.Literal) =>
  literalTableScalar(table, field, ast.literal)

const enumTableScalar = (table: string, field: string) => (ast: SchemaAST.Enum) => {
  const scalars = Array.map(ast.enums, classifyEnumEntry)
  return commonTableScalar(table, field, scalars)
}

const unionTableScalar = (
  table: string,
  field: string,
  suspends: HashSet.HashSet<SchemaAST.Suspend>,
) => (ast: SchemaAST.Union) => {
  const scalarForMember = (member: SchemaAST.AST) =>
    evaluateTableScalar(table, field, member, suspends)

  const effects = Array.map(ast.types, scalarForMember)
  return pipe(
    Effect.all(effects),
    Effect.flatMap((scalars) => commonTableScalar(table, field, scalars)),
  )
}

const evaluateTableScalar = (
  table: string,
  field: string,
  ast: SchemaAST.AST,
  suspends: HashSet.HashSet<SchemaAST.Suspend> = HashSet.empty(),
): Effect.Effect<TableField["scalar"], TableDefinitionError> => {
  if (!SchemaAST.isSuspend(ast)) {
    const unsupported = unsupportedTableScalar(table, field)
    return pipe(
      Match.value(ast),
      Match.when(SchemaAST.isDeclaration, declarationTableScalar(table, field)),
      Match.when(SchemaAST.isString, Function.constant(stringScalar)),
      Match.when(SchemaAST.isTemplateLiteral, Function.constant(stringScalar)),
      Match.when(SchemaAST.isNumber, numberTableScalar),
      Match.when(SchemaAST.isBoolean, Function.constant(integerScalar)),
      Match.when(SchemaAST.isLiteral, literalTableScalarFor(table, field)),
      Match.when(SchemaAST.isEnum, enumTableScalar(table, field)),
      Match.when(SchemaAST.isUnion, unionTableScalar(table, field, suspends)),
      Match.orElse(Function.constant(unsupported)),
    )
  }

  const circular = HashSet.has(suspends, ast)
  if (circular) return unsupportedTableScalar(table, field)

  const nextAst = ast.thunk()
  const nextSuspends = HashSet.add(suspends, ast)
  return evaluateTableScalar(table, field, nextAst, nextSuspends)
}

const flattenGroupChecks = (
  group: SchemaAST.FilterGroup<unknown>,
): ReadonlyArray<SchemaAST.Filter<unknown>> =>
  Array.flatMap(group.checks, flattenFilterChecks)

const singletonFilter = (filter: SchemaAST.Filter<unknown>) => [filter]

const flattenFilterChecks = (
  check: SchemaAST.Filter<unknown> | SchemaAST.FilterGroup<unknown>,
): ReadonlyArray<SchemaAST.Filter<unknown>> =>
  pipe(
    Match.value(check),
    Match.when({ _tag: "FilterGroup" }, flattenGroupChecks),
    Match.orElse(singletonFilter),
  )

const flattenChecks = (checks: Option.Option<SchemaAST.Checks>) =>
  Option.match(checks, {
    onNone: Function.constant<ReadonlyArray<SchemaAST.Filter<unknown>>>([]),
    onSome: (group) => Array.flatMap(group, flattenFilterChecks),
  })

const numberAt = (payload: unknown, key: string) => {
  if (!Predicate.isObject(payload)) {
    return Option.none<number>()
  }

  const descriptor = Object.getOwnPropertyDescriptor(payload, key)
  const value = Option.fromNullishOr(descriptor?.value)
  return Option.filter(value, Predicate.isNumber)
}

const flagAt = (payload: unknown, key: string) => {
  const descriptor = Predicate.isObject(payload)
    ? Object.getOwnPropertyDescriptor(payload, key)
    : undefined

  const value = Option.fromNullishOr(descriptor?.value)
  return Option.exists(value, trueFlag)
}

const greaterThan = (value: number) => GreaterThan.make({ value })
const greaterThanOrEqualTo = (value: number) => GreaterThanOrEqualTo.make({ value })
const lessThan = (value: number) => LessThan.make({ value })
const lessThanOrEqualTo = (value: number) => LessThanOrEqualTo.make({ value })
const minLength = (value: number) => MinLength.make({ value })
const maxLength = (value: number) => MaxLength.make({ value })

const singleChecks = (
  value: Option.Option<number>,
  make: (value: number) => TableCheck,
): ReadonlyArray<TableCheck> => Option.match(value, {
  onNone: Function.constant(NoTableChecks),
  onSome: (number) => [make(number)],
})

const betweenChecks = (payload: unknown) => (
  [low, high]: readonly [number, number],
): ReadonlyArray<TableCheck> => {
  const minimumExclusive = flagAt(payload, "exclusiveMinimum")
  const maximumExclusive = flagAt(payload, "exclusiveMaximum")
  const lower = minimumExclusive ? greaterThan(low) : greaterThanOrEqualTo(low)
  const upper = maximumExclusive ? lessThan(high) : lessThanOrEqualTo(high)
  return [lower, upper]
}

const tableChecksFromUnknown = (representation: unknown) => {
  if (!Predicate.isObject(representation)) return NoTableChecks

  const idDescriptor = Object.getOwnPropertyDescriptor(representation, "id")
  const id = idDescriptor?.value
  if (!Predicate.isString(id)) return NoTableChecks

  const payloadDescriptor = Object.getOwnPropertyDescriptor(representation, "payload")
  const payload = payloadDescriptor?.value
  const minimum = numberAt(payload, "minimum")
  const maximum = numberAt(payload, "maximum")
  const exclusiveMinimum = numberAt(payload, "exclusiveMinimum")
  const exclusiveMaximum = numberAt(payload, "exclusiveMaximum")
  const minLengthValue = numberAt(payload, "minLength")
  const maxLengthValue = numberAt(payload, "maxLength")
  const greater = singleChecks(exclusiveMinimum, greaterThan)
  const greaterOrEqual = singleChecks(minimum, greaterThanOrEqualTo)
  const less = singleChecks(exclusiveMaximum, lessThan)
  const lessOrEqual = singleChecks(maximum, lessThanOrEqualTo)
  const minimumLength = singleChecks(minLengthValue, minLength)
  const maximumLength = singleChecks(maxLengthValue, maxLength)

  const interval = pipe(
    Option.all([minimum, maximum]),
    Option.match({
      onNone: Function.constant(NoTableChecks),
      onSome: betweenChecks(payload),
    }),
  )

  return pipe(
    Match.value(id),
    Match.when("effect/schema/isGreaterThan", Function.constant(greater)),
    Match.when("effect/schema/isGreaterThanOrEqualTo", Function.constant(greaterOrEqual)),
    Match.when("effect/schema/isLessThan", Function.constant(less)),
    Match.when("effect/schema/isLessThanOrEqualTo", Function.constant(lessOrEqual)),
    Match.when("effect/schema/isMinLength", Function.constant(minimumLength)),
    Match.when("effect/schema/isMaxLength", Function.constant(maximumLength)),
    Match.when("effect/schema/isBetween", Function.constant(interval)),
    Match.orElse(Function.constant(NoTableChecks)),
  )
}

const checksForFilter = (filter: SchemaAST.Filter<unknown>) => {
  const representation = Option.fromNullishOr(filter.annotations?.representation)
  return Option.match(representation, {
    onNone: noTableChecks,
    onSome: tableChecksFromUnknown,
  })
}

const tableChecksFromAst = (ast: SchemaAST.AST) => {
  const checks = Option.fromNullishOr(ast.checks)
  const flattened = flattenChecks(checks)
  return Array.flatMap(flattened, checksForFilter)
}

const literalValuesFromLiteral = (literal: SchemaAST.Literal) => {
  const scalarLiteral = Predicate.isString(literal.literal) || Predicate.isNumber(literal.literal)
  return scalarLiteral
    ? Option.some([literal.literal] as ReadonlyArray<string | number>)
    : Option.none()
}

const literalValuesFromEnum = (enumeration: SchemaAST.Enum) =>
  pipe(
    Array.map(enumeration.enums, enumValue),
    Option.some,
  )

const literalValuesFromAst = (ast: SchemaAST.AST) =>
  pipe(
    Match.value(ast),
    Match.when(SchemaAST.isLiteral, literalValuesFromLiteral),
    Match.when(SchemaAST.isEnum, literalValuesFromEnum),
    Match.when(SchemaAST.isUnion, (union) => {
      const values: ReadonlyArray<Option.Option<ReadonlyArray<string | number>>> =
        Array.map(union.types, literalValuesFromAst)

      const combined = Option.all(values)
      return Option.map(combined, Array.flatten)
    }),
    Match.orElse(noLiteralValues),
  )

const SchemaAstSchema = Schema.Union([
  Schema.instanceOf(SchemaAST.Declaration),
  Schema.instanceOf(SchemaAST.Null),
  Schema.instanceOf(SchemaAST.Undefined),
  Schema.instanceOf(SchemaAST.Void),
  Schema.instanceOf(SchemaAST.Never),
  Schema.instanceOf(SchemaAST.Unknown),
  Schema.instanceOf(SchemaAST.Any),
  Schema.instanceOf(SchemaAST.String),
  Schema.instanceOf(SchemaAST.Number),
  Schema.instanceOf(SchemaAST.Boolean),
  Schema.instanceOf(SchemaAST.BigInt),
  Schema.instanceOf(SchemaAST.Symbol),
  Schema.instanceOf(SchemaAST.Literal),
  Schema.instanceOf(SchemaAST.UniqueSymbol),
  Schema.instanceOf(SchemaAST.ObjectKeyword),
  Schema.instanceOf(SchemaAST.Enum),
  Schema.instanceOf(SchemaAST.TemplateLiteral),
  Schema.instanceOf(SchemaAST.Arrays),
  Schema.instanceOf(SchemaAST.Objects),
  Schema.instanceOf(SchemaAST.Union),
  Schema.instanceOf(SchemaAST.Suspend),
])

class NullableAst extends Schema.Class<NullableAst>("NullableAst")({
  ast: SchemaAstSchema,
  nullable: Schema.Boolean,
}) {}

const nullableAst = (ast: SchemaAST.AST): NullableAst => {
  if (!SchemaAST.isUnion(ast)) return NullableAst.make({ ast, nullable: false })

  const nonNull = Array.filter(ast.types, nonNullAst)
  const hasNull = nonNull.length < ast.types.length
  const hasNonNull = Array.isReadonlyArrayNonEmpty(nonNull)
  const nullable = hasNull && hasNonNull
  if (!nullable) return NullableAst.make({ ast, nullable: false })

  const oneNonNull = Equivalence.strictEqual<number>()(nonNull.length, 1)

  const narrowAst = oneNonNull
    ? Array.headNonEmpty(nonNull)
    : new SchemaAST.Union(nonNull, ast.mode)

  return NullableAst.make({ ast: narrowAst, nullable: true })
}

const physicalScalar = Effect.fn("Table.physicalScalar")(function* (
  table: string,
  field: string,
  ast: SchemaAST.AST,
) {
  const physical = nullableAst(ast)
  const scalar = yield* evaluateTableScalar(table, field, physical.ast)
  return { scalar, nullable: physical.nullable }
})

const appendOneOf = (checks: ReadonlyArray<TableCheck>) => (values: ReadonlyArray<string | number>) => {
  const oneOf = OneOf.make({ values })
  return Array.append(checks, oneOf)
}

const tableChecks = (ast: SchemaAST.AST) => {
  const physical = nullableAst(ast)
  const direct = tableChecksFromAst(ast)
  const sameAst = Equivalence.strictEqual<SchemaAST.AST>()(physical.ast, ast)
  const fromNullable = sameAst ? NoTableChecks : tableChecksFromAst(physical.ast)
  const checks = Array.appendAll(direct, fromNullable)
  const oneOf = literalValuesFromAst(physical.ast)

  return Option.match(oneOf, {
    onNone: Function.constant(checks),
    onSome: appendOneOf(checks),
  })
}

const automaticStorageAst = (ast: SchemaAST.AST) => {
  const physical = nullableAst(ast)
  const id = representationId(physical.ast)
  const utc = Option.exists(id, dateTimeUtcId)
  return SchemaAST.isBoolean(physical.ast) || utc
}

const storageSchemaFor = <S extends Schema.Constraint>(
  table: string,
  field: string,
  schema: S,
) => {
  const encodedSchema = Schema.toEncoded(schema)
  if (!automaticStorageAst(encodedSchema.ast)) {
    return pipe(
      physicalScalar(table, field, encodedSchema.ast),
      Effect.as(schema),
    )
  }

  const encodedType = SchemaAST.toType(schema.ast)
  const physical = nullableAst(encodedType)
  const id = representationId(physical.ast)
  const utc = Option.exists(id, dateTimeUtcId)
  const booleanAst = SchemaAST.isBoolean(physical.ast)
  const utcSchema = physical.nullable ? NullableDateTimeUtcFromStringSchema : Schema.DateTimeUtcFromString
  const booleanSchema = physical.nullable ? NullableBooleanFromBitSchema : Schema.BooleanFromBit

  if (utc) {
    const decodedSchema = Schema.decodeTo(schema)(utcSchema)
    return Effect.succeed(decodedSchema)
  }

  if (booleanAst) {
    const decodedSchema = Schema.decodeTo(schema)(booleanSchema)
    return Effect.succeed(decodedSchema)
  }

  return unsupportedTableScalar(table, field)
}

type CompiledField = Readonly<{
  name: string
  storageSchema: Schema.Constraint
  field: TableField
}>

const StorageSchemaSchema = Schema.declare<Schema.Constraint>(Schema.isSchema)

class StorageEntry extends Schema.Class<StorageEntry>("StorageEntry")({
  name: Schema.String,
  storageSchema: StorageSchemaSchema,
}) {}

const compiledStorageEntry = (field: CompiledField) =>
  StorageEntry.make({ name: field.name, storageSchema: field.storageSchema })

const storagePair = (entry: StorageEntry) =>
  [entry.name, entry.storageSchema] as const

const applyRootChecks = <Fields extends Schema.Struct.Fields>(
  storageSchema: Schema.Struct<Fields>,
) => (checks: SchemaAST.Checks) => storageSchema.check(...checks)

const compileStorageSchema = (
  schema: Schema.Struct<Schema.Struct.Fields>,
  storageEntries: ReadonlyArray<StorageEntry>,
) => {
  const storagePairs = Array.map(storageEntries, storagePair)
  const storageFields = Record.fromEntries(storagePairs)
  const StorageSchema = pipe(storageFields, Schema.Struct)
  const typeAst = SchemaAST.toType(schema.ast)
  const rootChecks = Option.fromNullishOr(typeAst.checks)

  return Option.match(rootChecks, {
    onNone: Function.constant(StorageSchema),
    onSome: applyRootChecks(StorageSchema),
  })
}

type IdentifierName<S extends Schema.Struct<Schema.Struct.Fields>> = {
  [K in Extract<keyof S["fields"], string>]: S["fields"][K] extends import("effect").Brand.Brand<
    typeof DomainIdentifier
  > ? K
    : never
}[Extract<keyof S["fields"], string>]

type RowSchema<S extends Schema.Struct<Schema.Struct.Fields>> = [IdentifierName<S>] extends [never]
  ? Schema.Struct<Readonly<typeof DefaultIdentifierFields> & S["fields"]>
  : S

type IdentifierSchema<S extends Schema.Struct<Schema.Struct.Fields>> =
  [IdentifierName<S>] extends [never]
    ? typeof DefaultIdentifierFields.id
    : S["fields"][IdentifierName<S>]


const compileTable = Effect.fn("Table.compile")(function* <
  const Name extends string,
  const S extends Schema.Struct<Schema.Struct.Fields>,
>(name: Name, schema: S) {
  const encodedSchema = Schema.toEncoded(schema)
  if (!SchemaAST.isObjects(encodedSchema.ast)) {
    return yield* failTableDefinition(name, "schema must encode to a flat struct")
  }

  const hasIndexSignatures = encodedSchema.ast.indexSignatures.length > 0
  if (hasIndexSignatures) {
    return yield* failTableDefinition(name, "schema must not contain index signatures")
  }

  const compileField = Effect.fn("Table.compileField")(function* (
    property: (typeof encodedSchema.ast.propertySignatures)[number],
  ) {
    if (!Predicate.isString(property.name)) {
      return yield* failTableDefinition(name, "field names must be strings")
    }
    if (SchemaAST.isOptional(property.type)) {
      return yield* failTableDefinition(name, `field ${property.name} must be required`)
    }

    const sourceField = Option.fromNullishOr(schema.fields[property.name])
    const fieldSchema = Option.getOrThrow(sourceField)
    const storageSchema = yield* storageSchemaFor(name, property.name, fieldSchema)
    const encodedStorageSchema = Schema.toEncoded(storageSchema)
    const storage = yield* physicalScalar(name, property.name, encodedStorageSchema.ast)

    return {
      name: property.name,
      storageSchema,
      field: TableField.make({
        name: property.name,
        scalar: storage.scalar,
        nullable: storage.nullable,
        generation: NoGeneration,
        checks: tableChecks(encodedStorageSchema.ast),
      }),
    } satisfies CompiledField
  })

  const compiledFields = yield* Effect.forEach(
    encodedSchema.ast.propertySignatures,
    compileField,
  )

  const fields = Array.map(compiledFields, Struct.get("field"))
  const storageEntries = Array.map(compiledFields, compiledStorageEntry)

  const identifierAnnotation = (fieldSchema: Schema.Constraint) => {
    const annotations = Schema.resolveAnnotations(fieldSchema)
    const resolved = Option.fromNullishOr(annotations)
    const marked = Option.map(resolved, (resolvedAnnotations) => resolvedAnnotations[DomainIdentifier])
    return Option.exists(marked, trueFlag)
  }

  const fieldHasIdentifier = (compiled: CompiledField) => {
    const source = Option.fromNullishOr(schema.fields[compiled.name])
    return Option.exists(source, identifierAnnotation)
  }

  const identifierFields = Array.filter(compiledFields, fieldHasIdentifier)
  if (identifierFields.length > 1) {
    return yield* failTableDefinition(name, "schema must contain at most one Domain.identifier field")
  }

  const identifierField = Array.get(identifierFields, 0)
  if (Option.isSome(identifierField)) {
    const source = Option.fromNullishOr(
      schema.fields[identifierField.value.name as Extract<keyof S["fields"], string>],
    )

    const identifierSchema = Option.getOrThrow(source)
    const storageSchema = compileStorageSchema(schema, storageEntries)

    return {
      name,
      schema,
      rowSchema: schema,
      identifier: identifierField.value.name,
      identifierSchema,
      fields,
      insertSchema: storageSchema,
      storageSchema,
      identifierStorageSchema: identifierField.value.storageSchema,
    }
  }

  const isNamedId = (field: TableField) =>
    Equivalence.strictEqual<string>()(field.name, "id")

  const idIsReserved = Array.some(fields, isNamedId)
  if (idIsReserved) {
    return yield* failTableDefinition(
      name,
      "field id must use Domain.identifier when overriding the default UUIDv7 identifier",
    )
  }

  const rowSchema = pipe(schema, Schema.fieldsAssign(DefaultIdentifierFields))
  const identifierStorageSchema = yield* storageSchemaFor(name, "id", rowSchema.fields.id)

  const identifierStorageEntry = StorageEntry.make({
    name: "id",
    storageSchema: identifierStorageSchema,
  })

  const storageEntriesWithIdentifier = Array.prepend(storageEntries, identifierStorageEntry)
  const insertSchema = compileStorageSchema(schema, storageEntries)
  const storageSchema = compileStorageSchema(rowSchema, storageEntriesWithIdentifier)
  const fieldsWithDefaultIdentifier = Array.prepend(fields, DefaultIdentifierField)

  return {
    name,
    schema,
    rowSchema,
    identifier: "id" as const,
    identifierSchema: rowSchema.fields.id,
    fields: fieldsWithDefaultIdentifier,
    insertSchema,
    storageSchema,
    identifierStorageSchema,
  }
})

export interface Table {
  readonly name: string
  readonly schema: Schema.Struct<Schema.Struct.Fields>
  readonly rowSchema: Schema.Struct<Schema.Struct.Fields>
  readonly insertSchema: Schema.Codec<unknown, unknown, unknown, unknown>
  readonly storageSchema: Schema.Codec<unknown, unknown, unknown, unknown>
  readonly identifier: string
  readonly identifierSchema: Schema.Constraint
  readonly identifierStorageSchema: Schema.Constraint
  readonly fields: ReadonlyArray<TableField>
}

interface TableDefinition<
  Name extends string,
  S extends Schema.Struct<Schema.Struct.Fields>,
  K extends string,
  Row extends Schema.Struct<Schema.Struct.Fields>,
  Identifier extends Schema.Constraint,
> {
  readonly name: Name
  readonly rowSchema: Row
  readonly insertSchema: Schema.Codec<
    S["Type"],
    Readonly<Record<string, unknown>>,
    S["DecodingServices"],
    S["EncodingServices"]
  >
  readonly storageSchema: Schema.Codec<
    Row["Type"],
    Readonly<Record<string, unknown>>,
    Row["DecodingServices"],
    Row["EncodingServices"]
  >
  readonly identifier: K
  readonly identifierSchema: Identifier
  readonly identifierStorageSchema: Schema.Codec<
    Identifier["Type"],
    unknown,
    Identifier["DecodingServices"],
    Identifier["EncodingServices"]
  >
}

const make = <
  const Name extends string,
  const S extends Schema.Struct<Schema.Struct.Fields>,
>(
  options: Readonly<{
    name: Name
    schema: S
  }>,
): Table & TableDefinition<
  Name,
  S,
  [IdentifierName<S>] extends [never] ? "id" : IdentifierName<S>,
  RowSchema<S>,
  IdentifierSchema<S>
> => {
  const result = pipe(
    compileTable(options.name, options.schema),
    Effect.runSync,
  )

  return result as typeof result & Table & TableDefinition<
    Name,
    S,
    [IdentifierName<S>] extends [never] ? "id" : IdentifierName<S>,
    RowSchema<S>,
    IdentifierSchema<S>
  >
}

const snapshotCheck = (check: TableCheck) => {
  if (!Schema.is(OneOf)(check)) return check

  const values = [...check.values]
  return OneOf.make({ values })
}

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

  return TableSnapshot.make({
    name: table.name,
    identifier: table.identifier,
    fields,
  })
}

export const Table = { make, snapshot }
