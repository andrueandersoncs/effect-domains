import {
  Array,
  Context,
  Effect,
  Equivalence,
  Function,
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
import {
  evaluate,
  type SchemaASTF,
  type SchemaASTFAlgebra,
} from "./schema-ast.ts"

const UuidV7Check = Schema.isUUID(7)
export const DefaultTableIdentifierSchema = Schema.String.check(UuidV7Check)

const CreateTableOperationSchema = Schema.Literal("createTable")
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

const scalarEquals = Equivalence.strictEqual<TableField["scalar"]>()
const integerScalarEquals = (scalar: TableField["scalar"]) => scalarEquals(scalar, "integer")
const numberScalarEquals = (scalar: TableField["scalar"]) => scalarEquals(scalar, "number")

const commonTableScalar = (
  table: string,
  field: string,
  scalars: ReadonlyArray<TableField["scalar"]>,
) => {
  const firstScalar = Array.get(scalars, 0)
  if (Option.isNone(firstScalar)) {
    return unsupportedTableScalar(table, field)
  }

  const scalarEqualsFirst = (scalar: TableField["scalar"]) => scalarEquals(firstScalar.value, scalar)
  const integerScalars = Array.filter(scalars, integerScalarEquals)
  const numberScalars = Array.filter(scalars, numberScalarEquals)
  const numericCount = integerScalars.length + numberScalars.length
  const allNumeric = Equivalence.strictEqual<number>()(numericCount, scalars.length)
  if (Array.every(scalars, scalarEqualsFirst)) {
    return Effect.succeed(firstScalar.value)
  }

  return allNumeric
    ? Effect.succeed("number" as const)
    : unsupportedTableScalar(table, field)
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
const makeGreaterThan = (value: number) => GreaterThan.make({ value })
const makeGreaterThanOrEqualTo = (value: number) => GreaterThanOrEqualTo.make({ value })
const makeLessThan = (value: number) => LessThan.make({ value })
const makeLessThanOrEqualTo = (value: number) => LessThanOrEqualTo.make({ value })
const makeMinLength = (value: number) => MinLength.make({ value })
const makeMaxLength = (value: number) => MaxLength.make({ value })
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

const evaluateTableScalar = Effect.fn("Table.evaluateScalar")(function* (
  table: string,
  field: string,
  ast: SchemaAST.AST,
) {
  const unsupported = () => unsupportedTableScalar(table, field)

  const algebra: SchemaASTFAlgebra<
    Effect.Effect<TableField["scalar"], TableDefinitionError>
  > = pipe(
    Match.type<SchemaASTF<Effect.Effect<TableField["scalar"], TableDefinitionError>>>(),
    Match.tagsExhaustive({
      Declaration: (declaration) => {
        const id = representationId(declaration.ast)
        const isUtc = Option.exists(id, dateTimeUtcId)
        return isUtc ? stringScalar : unsupported()
      },
      Null: unsupported,
      Undefined: unsupported,
      Void: unsupported,
      Never: unsupported,
      Unknown: unsupported,
      Any: unsupported,
      String: Function.constant(stringScalar),
      Number: (number) => {
        const integer = integerAst(number.ast)
        return integer ? integerScalar : numberScalar
      },
      Boolean: Function.constant(integerScalar),
      BigInt: unsupported,
      Symbol: unsupported,
      Literal: (literal) => literalTableScalar(table, field, literal.ast.literal),
      UniqueSymbol: unsupported,
      ObjectKeyword: unsupported,
      Enum: (enumeration) => {
        const scalars = Array.map(enumeration.ast.enums, classifyEnumEntry)
        return commonTableScalar(table, field, scalars)
      },
      TemplateLiteral: Function.constant(stringScalar),
      Arrays: unsupported,
      Objects: unsupported,
      Union: (union) => {
        const unionScalars = (values: ReadonlyArray<TableField["scalar"]>) =>
          commonTableScalar(table, field, values)

        return pipe(Effect.all(union.types), Effect.flatMap(unionScalars))
      },
      Suspend: (suspend) => suspend.thunk(),
    }),
  )

  return yield* evaluate(ast, algebra, unsupported)
})

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

const tableChecksFromNumber = (
  value: Option.Option<number>,
  makeCheck: (amount: number) => TableCheck,
) =>
  Option.match(value, {
    onNone: noTableChecks,
    onSome: (amount) => [makeCheck(amount)],
  })

const greaterThanChecks = (exclusiveMinimum: Option.Option<number>) =>
  tableChecksFromNumber(exclusiveMinimum, makeGreaterThan)

const minimumChecks = (minimum: Option.Option<number>) =>
  tableChecksFromNumber(minimum, makeGreaterThanOrEqualTo)

const lessThanChecks = (exclusiveMaximum: Option.Option<number>) =>
  tableChecksFromNumber(exclusiveMaximum, makeLessThan)

const maximumChecks = (maximum: Option.Option<number>) =>
  tableChecksFromNumber(maximum, makeLessThanOrEqualTo)

const minLengthChecks = (minLength: Option.Option<number>) =>
  tableChecksFromNumber(minLength, makeMinLength)

const maxLengthChecks = (maxLength: Option.Option<number>) =>
  tableChecksFromNumber(maxLength, makeMaxLength)

const betweenBound = (
  exclusive: boolean,
  value: number,
  exclusiveCheck: (value: number) => TableCheck,
  inclusiveCheck: (value: number) => TableCheck,
) => exclusive ? exclusiveCheck(value) : inclusiveCheck(value)

const betweenBounds = (payload: unknown, low: number) => (high: number) => {
  const exclusiveMinimum = flagAt(payload, "exclusiveMinimum")
  const exclusiveMaximum = flagAt(payload, "exclusiveMaximum")
  return [
    betweenBound(exclusiveMinimum, low, makeGreaterThan, makeGreaterThanOrEqualTo),
    betweenBound(exclusiveMaximum, high, makeLessThan, makeLessThanOrEqualTo),
  ]
}

const betweenMaximum = (payload: unknown, maximum: Option.Option<number>) => (low: number) =>
  Option.match(maximum, {
    onNone: noTableChecks,
    onSome: betweenBounds(payload, low),
  })

const betweenChecks = (
  payload: unknown,
  minimum: Option.Option<number>,
  maximum: Option.Option<number>,
) =>
  Option.match(minimum, {
    onNone: noTableChecks,
    onSome: betweenMaximum(payload, maximum),
  })

const tableChecksFromUnknown = (representation: unknown) => {
  if (!Predicate.isObject(representation)) {
    return NoTableChecks
  }

  const idDescriptor = Object.getOwnPropertyDescriptor(representation, "id")
  const idValue = Option.fromNullishOr(idDescriptor?.value)
  const id = Option.filter(idValue, Predicate.isString)
  if (Option.isNone(id)) {
    return NoTableChecks
  }

  const payloadDescriptor = Object.getOwnPropertyDescriptor(representation, "payload")
  const payload = payloadDescriptor?.value
  const minimum = numberAt(payload, "minimum")
  const maximum = numberAt(payload, "maximum")
  const exclusiveMinimum = numberAt(payload, "exclusiveMinimum")
  const exclusiveMaximum = numberAt(payload, "exclusiveMaximum")
  const minLength = numberAt(payload, "minLength")
  const maxLength = numberAt(payload, "maxLength")

  return pipe(
    Match.value(id.value),
    Match.when("effect/schema/isGreaterThan", () => greaterThanChecks(exclusiveMinimum)),
    Match.when("effect/schema/isGreaterThanOrEqualTo", () => minimumChecks(minimum)),
    Match.when("effect/schema/isLessThan", () => lessThanChecks(exclusiveMaximum)),
    Match.when("effect/schema/isLessThanOrEqualTo", () => maximumChecks(maximum)),
    Match.when("effect/schema/isBetween", () => betweenChecks(payload, minimum, maximum)),
    Match.when("effect/schema/isMinLength", () => minLengthChecks(minLength)),
    Match.when("effect/schema/isMaxLength", () => maxLengthChecks(maxLength)),
    Match.orElse(noTableChecks),
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

class NullableAst extends Schema.Class<NullableAst>("NullableAst")({
  ast: Schema.Any,
  nullable: Schema.Boolean,
}) {}

const nullableAst = (ast: SchemaAST.AST) => {
  if (!SchemaAST.isUnion(ast)) {
    return NullableAst.make({ ast, nullable: false })
  }

  const nonNull = Array.filter(ast.types, nonNullAst)
  const hasNull = !Equivalence.strictEqual<number>()(nonNull.length, ast.types.length)
  const hasNonNull = Array.isArrayNonEmpty(nonNull)
  const canBeNullable = hasNull && hasNonNull
  if (!canBeNullable) {
    return NullableAst.make({ ast, nullable: false })
  }

  const onlyMember = Equivalence.strictEqual<number>()(nonNull.length, 1)
  const first = Array.get(nonNull, 0)

  const scalarAst = onlyMember && Option.isSome(first)
    ? first.value
    : new SchemaAST.Union(nonNull, ast.mode)

  return NullableAst.make({ ast: scalarAst, nullable: true })
}

const physicalScalar = Effect.fn("Table.physicalScalar")(function* (
  table: string,
  field: string,
  ast: SchemaAST.AST,
) {
  const nullable = nullableAst(ast)
  const scalar = yield* evaluateTableScalar(table, field, nullable.ast)
  return { scalar, nullable: nullable.nullable }
})

const appendOneOf = (checks: ReadonlyArray<TableCheck>) => (values: ReadonlyArray<string | number>) => {
  const oneOf = OneOf.make({ values })
  return Array.append(checks, oneOf)
}

const tableChecks = (ast: SchemaAST.AST) => {
  const nullable = nullableAst(ast)
  const direct = tableChecksFromAst(ast)
  const sameAst = Equivalence.strictEqual<SchemaAST.AST>()(nullable.ast, ast)
  const fromNullable = sameAst ? NoTableChecks : tableChecksFromAst(nullable.ast)
  const checks = Array.appendAll(direct, fromNullable)
  const oneOf = literalValuesFromAst(nullable.ast)

  return Option.match(oneOf, {
    onNone: Function.constant(checks),
    onSome: appendOneOf(checks),
  })
}

const automaticStorageAst = (ast: SchemaAST.AST) => {
  const nullable = nullableAst(ast)
  const id = representationId(nullable.ast)
  const utc = Option.exists(id, dateTimeUtcId)
  return SchemaAST.isBoolean(nullable.ast) || utc
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
  const type = nullableAst(encodedType)
  const id = representationId(type.ast)
  const utc = Option.exists(id, dateTimeUtcId)
  const booleanAst = SchemaAST.isBoolean(type.ast)
  const utcSchema = type.nullable ? NullableDateTimeUtcFromStringSchema : Schema.DateTimeUtcFromString
  const booleanSchema = type.nullable ? NullableBooleanFromBitSchema : Schema.BooleanFromBit

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

const compileStorageSchema = Effect.fn("Table.compileStorageSchema")(function* <
  S extends Schema.Struct<Schema.Struct.Fields>,
>(table: string, schema: S) {
  const fieldEntries = Record.toEntries(schema.fields)

  const compiledFields = yield* Effect.forEach(
    fieldEntries,
    ([name, fieldSchema]) => {
      const compiled = storageSchemaFor(table, name, fieldSchema)
      return Effect.map(compiled, (storage) => [name, storage] as const)
    },
  )

  const storageFields = Record.fromEntries(compiledFields)
  const CompiledStorageSchema = Schema.Struct(storageFields)
  interface CompiledStorage extends Schema.Schema.Type<typeof CompiledStorageSchema> {}
  const encodedType = SchemaAST.toType(schema.ast)
  const rootChecks = Option.fromNullishOr(encodedType.checks)

  return Option.match(rootChecks, {
    onNone: Function.constant(CompiledStorageSchema as Schema.Constraint),
    onSome: (checks) => CompiledStorageSchema.check(...checks) as Schema.Constraint,
  })
})

export class TableError extends Schema.TaggedError<TableError>()(
  "TableError",
  {
    operation: CreateTableOperationSchema,
    table: Schema.String,
    cause: Schema.Unknown,
  },
) {
  override get message() {
    return `Table creation failed for ${this.table}`
  }
}

export class TableStore extends Context.Service<TableStore, {
  readonly write: (
    table: Table,
  ) => Effect.Effect<void, TableError>
}>()("@effect-domains/TableStore") {}

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
    const checks = tableChecks(encodedStorageSchema.ast)

    return TableField.make({
      name: property.name,
      scalar: storage.scalar,
      nullable: storage.nullable,
      generation: NoGeneration,
      checks,
    })
  })

  const fields = yield* Effect.forEach(
    encodedSchema.ast.propertySignatures,
    compileField,
  )

  const identifierAnnotation = (fieldSchema: Schema.Constraint) => {
    const annotations = Schema.resolveAnnotations(fieldSchema)
    const resolved = Option.fromNullishOr(annotations)
    const marked = Option.map(resolved, (resolvedAnnotations) => resolvedAnnotations[DomainIdentifier])
    return Option.exists(marked, trueFlag)
  }

  const fieldHasIdentifier = (field: TableField) => {
    const source = Option.fromNullishOr(schema.fields[field.name] as Schema.Constraint | undefined)
    return Option.exists(source, identifierAnnotation)
  }

  const identifierFields = Array.filter(fields, fieldHasIdentifier)
  const multipleIdentifiers = identifierFields.length > 1
  if (multipleIdentifiers) {
    return yield* failTableDefinition(name, "schema must contain at most one Domain.identifier field")
  }

  const identifierFieldOption = Array.get(identifierFields, 0)
  if (Option.isSome(identifierFieldOption)) {
    const identifierSource = Option.fromNullishOr(
      schema.fields[identifierFieldOption.value.name as Extract<keyof S["fields"], string>],
    )

    const identifierSchema = Option.getOrThrow(identifierSource)
    const storageSchema = yield* compileStorageSchema(name, schema)

    const identifierStorageSchema = yield* storageSchemaFor(
      name,
      identifierFieldOption.value.name,
      identifierSchema,
    )

    return {
      name,
      schema,
      rowSchema: schema,
      identifier: identifierFieldOption.value.name,
      identifierSchema,
      fields,
      insertSchema: storageSchema,
      storageSchema,
      identifierStorageSchema,
    }
  }

  const namedId = (field: TableField) => Equivalence.strictEqual<string>()(field.name, "id")
  const idIsReserved = Array.some(fields, namedId)
  if (idIsReserved) {
    return yield* failTableDefinition(
      name,
      "field id must use Domain.identifier when overriding the default UUIDv7 identifier",
    )
  }

  const rowSchema = pipe(schema, Schema.fieldsAssign(DefaultIdentifierFields))
  const insertSchema = yield* compileStorageSchema(name, schema)
  const storageSchema = yield* compileStorageSchema(name, rowSchema)
  const identifierStorageSchema = yield* storageSchemaFor(name, "id", rowSchema.fields.id)
  const persistedFields = Array.prepend(fields, DefaultIdentifierField)

  return {
    name,
    schema,
    rowSchema,
    identifier: "id" as const,
    identifierSchema: rowSchema.fields.id,
    fields: persistedFields,
    insertSchema,
    storageSchema,
    identifierStorageSchema,
  }
})

export class Table extends Schema.Class<Table>("Table")({
  name: Schema.String,
  schema: Schema.Any,
  rowSchema: Schema.Any,
  insertSchema: Schema.Any,
  storageSchema: Schema.Any,
  identifier: Schema.String,
  identifierSchema: Schema.Any,
  identifierStorageSchema: Schema.Any,
  fields: TableFieldsSchema,
}) {
  static override make<
    const Name extends string,
    const S extends Schema.Struct<Schema.Struct.Fields>,
  >(
    options: Readonly<{
      name: Name
      schema: S
    }>,
  ): TableDefinition<
    Name,
    S,
    [IdentifierName<S>] extends [never] ? "id" : IdentifierName<S>,
    RowSchema<S>,
    IdentifierSchema<S>
  > {
    const compiledEffect = compileTable(options.name, options.schema)
    const compiled = Effect.runSync(compiledEffect)

    const base = super.make({
      name: compiled.name,
      schema: compiled.schema,
      rowSchema: compiled.rowSchema,
      insertSchema: compiled.insertSchema,
      storageSchema: compiled.storageSchema,
      identifier: compiled.identifier,
      identifierSchema: compiled.identifierSchema,
      identifierStorageSchema: compiled.identifierStorageSchema,
      fields: compiled.fields,
    })

    const table = Struct.assign(base, {
      write: Effect.fn("Table.write")(function* () {
        const store = yield* TableStore
        return yield* store.write(table)
      }),
    }) as TableDefinition<
      Name,
      S,
      [IdentifierName<S>] extends [never] ? "id" : IdentifierName<S>,
      RowSchema<S>,
      IdentifierSchema<S>
    >

    return table
  }

  static snapshot(table: Table) {
    const frozenChecks = Array.map(table.fields, (field) => {
      const checks = Array.map(field.checks, (check) => {
        const isOneOf = Schema.is(OneOf)(check)

        const frozen = isOneOf
          ? OneOf.make({ values: [...check.values] })
          : check

        return frozen
      })

      return TableField.make({
        name: field.name,
        scalar: field.scalar,
        nullable: field.nullable,
        generation: field.generation,
        checks,
      })
    })

    return TableSnapshot.make({
      name: table.name,
      identifier: table.identifier,
      fields: frozenChecks,
    })
  }
}

export interface TableDefinition<
  Name extends string,
  S extends Schema.Struct<Schema.Struct.Fields>,
  K extends string,
  Row extends Schema.Struct<Schema.Struct.Fields>,
  Identifier extends Schema.Constraint,
> extends Schema.Schema.Type<typeof Table> {
  readonly name: Name
  readonly schema: S
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
  readonly write: () => Effect.Effect<void, TableError, TableStore>
}
