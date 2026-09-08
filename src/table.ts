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
const commonTableScalar = (
  table: string,
  field: string,
  scalars: ReadonlyArray<TableField["scalar"]>,
) => {
  const first = scalars[0]
  if (first === undefined) return unsupportedTableScalar(table, field)

  let same = true
  let numeric = true
  for (const scalar of scalars) {
    same &&= scalar === first
    numeric &&= scalar === "integer" || scalar === "number"
  }

  if (same) return Effect.succeed(first)
  return numeric
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

const evaluateTableScalar = (
  table: string,
  field: string,
  ast: SchemaAST.AST,
  suspends: HashSet.HashSet<SchemaAST.Suspend> = HashSet.empty(),
): Effect.Effect<TableField["scalar"], TableDefinitionError> => {
  const unsupported = () => unsupportedTableScalar(table, field)

  if (SchemaAST.isSuspend(ast)) {
    return HashSet.has(suspends, ast)
      ? unsupported()
      : evaluateTableScalar(table, field, ast.thunk(), HashSet.add(suspends, ast))
  }

  if (SchemaAST.isDeclaration(ast)) {
    return Option.exists(representationId(ast), dateTimeUtcId) ? stringScalar : unsupported()
  }
  if (SchemaAST.isString(ast) || SchemaAST.isTemplateLiteral(ast)) return stringScalar
  if (SchemaAST.isNumber(ast)) return integerAst(ast) ? integerScalar : numberScalar
  if (SchemaAST.isBoolean(ast)) return integerScalar
  if (SchemaAST.isLiteral(ast)) return literalTableScalar(table, field, ast.literal)
  if (SchemaAST.isEnum(ast)) {
    return commonTableScalar(table, field, Array.map(ast.enums, classifyEnumEntry))
  }
  if (SchemaAST.isUnion(ast)) {
    return pipe(
      Effect.all(Array.map(ast.types, (member) => evaluateTableScalar(table, field, member, suspends))),
      Effect.flatMap((scalars) => commonTableScalar(table, field, scalars)),
    )
  }

  return unsupported()
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

const tableChecksFromUnknown = (representation: unknown) => {
  if (!Predicate.isObject(representation)) return NoTableChecks

  const id = Object.getOwnPropertyDescriptor(representation, "id")?.value
  if (!Predicate.isString(id)) return NoTableChecks

  const payload = Object.getOwnPropertyDescriptor(representation, "payload")?.value
  const minimum = numberAt(payload, "minimum")
  const maximum = numberAt(payload, "maximum")
  const exclusiveMinimum = numberAt(payload, "exclusiveMinimum")
  const exclusiveMaximum = numberAt(payload, "exclusiveMaximum")
  const minLength = numberAt(payload, "minLength")
  const maxLength = numberAt(payload, "maxLength")
  const single = (
    value: Option.Option<number>,
    make: (value: number) => TableCheck,
  ): ReadonlyArray<TableCheck> => Option.match(value, {
    onNone: Function.constant(NoTableChecks),
    onSome: (value) => [make(value)],
  })

  switch (id) {
    case "effect/schema/isGreaterThan":
      return single(exclusiveMinimum, (value) => GreaterThan.make({ value }))
    case "effect/schema/isGreaterThanOrEqualTo":
      return single(minimum, (value) => GreaterThanOrEqualTo.make({ value }))
    case "effect/schema/isLessThan":
      return single(exclusiveMaximum, (value) => LessThan.make({ value }))
    case "effect/schema/isLessThanOrEqualTo":
      return single(maximum, (value) => LessThanOrEqualTo.make({ value }))
    case "effect/schema/isMinLength":
      return single(minLength, (value) => MinLength.make({ value }))
    case "effect/schema/isMaxLength":
      return single(maxLength, (value) => MaxLength.make({ value }))
    case "effect/schema/isBetween":
      return Option.match(minimum, {
        onNone: Function.constant(NoTableChecks),
        onSome: (low) => Option.match(maximum, {
          onNone: Function.constant(NoTableChecks),
          onSome: (high) => [
            flagAt(payload, "exclusiveMinimum")
              ? GreaterThan.make({ value: low })
              : GreaterThanOrEqualTo.make({ value: low }),
            flagAt(payload, "exclusiveMaximum")
              ? LessThan.make({ value: high })
              : LessThanOrEqualTo.make({ value: high }),
          ],
        }),
      })
    default:
      return NoTableChecks
  }
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

type NullableAst = Readonly<{
  ast: SchemaAST.AST
  nullable: boolean
}>

const nullableAst = (ast: SchemaAST.AST): NullableAst => {
  if (!SchemaAST.isUnion(ast)) return { ast, nullable: false }

  const nonNull = Array.filter(ast.types, nonNullAst)
  if (nonNull.length === ast.types.length || !Array.isArrayNonEmpty(nonNull)) {
    return { ast, nullable: false }
  }

  return {
    ast: nonNull.length === 1 ? nonNull[0]! : new SchemaAST.Union(nonNull, ast.mode),
    nullable: true,
  }
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

type CompiledField = Readonly<{
  name: string
  storageSchema: Schema.Constraint
  field: TableField
}>

const compileStorageSchema = (
  schema: Schema.Struct<Schema.Struct.Fields>,
  fields: ReadonlyArray<CompiledField>,
) => {
  const storageFields = Record.fromEntries(
    Array.map(fields, ({ name, storageSchema }) => [name, storageSchema] as const),
  )
  const storageSchema = Schema.Struct(storageFields)
  const rootChecks = Option.fromNullishOr(SchemaAST.toType(schema.ast).checks)

  return Option.match(rootChecks, {
    onNone: Function.constant(storageSchema as Schema.Constraint),
    onSome: (checks) => storageSchema.check(...checks) as Schema.Constraint,
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
  const fields = Array.map(compiledFields, (compiled) => compiled.field)

  const identifierAnnotation = (fieldSchema: Schema.Constraint) => {
    const annotations = Schema.resolveAnnotations(fieldSchema)
    const resolved = Option.fromNullishOr(annotations)
    const marked = Option.map(resolved, (resolvedAnnotations) => resolvedAnnotations[DomainIdentifier])
    return Option.exists(marked, trueFlag)
  }
  const fieldHasIdentifier = (compiled: CompiledField) => {
    const source = Option.fromNullishOr(
      schema.fields[compiled.name] as Schema.Constraint | undefined,
    )
    return Option.exists(source, identifierAnnotation)
  }

  const identifierFields = Array.filter(compiledFields, fieldHasIdentifier)
  if (identifierFields.length > 1) {
    return yield* failTableDefinition(name, "schema must contain at most one Domain.identifier field")
  }

  const identifierField = identifierFields[0]
  if (identifierField !== undefined) {
    const identifierSchema = Option.getOrThrow(Option.fromNullishOr(
      schema.fields[identifierField.name as Extract<keyof S["fields"], string>],
    ))
    const storageSchema = compileStorageSchema(schema, compiledFields)

    return {
      name,
      schema,
      rowSchema: schema,
      identifier: identifierField.name,
      identifierSchema,
      fields,
      insertSchema: storageSchema,
      storageSchema,
      identifierStorageSchema: identifierField.storageSchema,
    }
  }

  const idIsReserved = Array.some(fields, (field) => field.name === "id")
  if (idIsReserved) {
    return yield* failTableDefinition(
      name,
      "field id must use Domain.identifier when overriding the default UUIDv7 identifier",
    )
  }

  const rowSchema = pipe(schema, Schema.fieldsAssign(DefaultIdentifierFields))
  const identifierStorageSchema = yield* storageSchemaFor(name, "id", rowSchema.fields.id)
  const storageSchema = compileStorageSchema(
    rowSchema,
    Array.prepend(compiledFields, {
      name: "id",
      storageSchema: identifierStorageSchema,
      field: DefaultIdentifierField,
    }),
  )

  return {
    name,
    schema,
    rowSchema,
    identifier: "id" as const,
    identifierSchema: rowSchema.fields.id,
    fields: Array.prepend(fields, DefaultIdentifierField),
    insertSchema: compileStorageSchema(schema, compiledFields),
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
  readonly identifierStorageSchema: Schema.Codec<unknown, unknown, unknown, unknown>
  readonly fields: ReadonlyArray<TableField>
}

export interface TableDefinition<
  Name extends string,
  S extends Schema.Struct<Schema.Struct.Fields>,
  K extends string,
  Row extends Schema.Struct<Schema.Struct.Fields>,
  Identifier extends Schema.Constraint,
> extends Table {
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
}

const make = <
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
> => Effect.runSync(compileTable(options.name, options.schema)) as unknown as TableDefinition<
  Name,
  S,
  [IdentifierName<S>] extends [never] ? "id" : IdentifierName<S>,
  RowSchema<S>,
  IdentifierSchema<S>
>

const snapshot = (table: Table) => {
  const fields = Array.map(table.fields, (field) => {
    const checks = Array.map(field.checks, (check) =>
      Schema.is(OneOf)(check) ? OneOf.make({ values: [...check.values] }) : check
    )

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
    fields,
  })
}

export const Table = { make, snapshot }
