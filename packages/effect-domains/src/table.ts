import {
  Array,
  Effect,
  Equivalence,
  Function,
  flow,
  HashSet,
  HashMap,
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

interface TableColumn {
  readonly storageSchema: Schema.Constraint
  readonly orderable: boolean
}

type TableColumns<Fields extends Schema.Struct.Fields> = Readonly<{
  [K in Extract<keyof Fields, string>]: TableColumn
}>


const TableFieldsSchema = Schema.Array(TableField)
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

export class TableRelations extends Schema.Class<TableRelations>("TableRelations")({
  unique: OptionalUniqueRelationsSchema,
  foreignKeys: OptionalForeignKeyRelationsSchema,
  indexes: OptionalIndexRelationsSchema,
}) {}

type TableRelationFields<Fields extends string> = readonly Fields[]

export type TableRelationsInput<Fields extends string = string> = Readonly<Partial<{
  unique: readonly Readonly<{ name: string; fields: TableRelationFields<Fields> }>[]
  foreignKeys: readonly Readonly<{
    name: string
    fields: TableRelationFields<Fields>
    references: Readonly<{ table: string; fields: readonly string[] }>
  }>[]
  indexes: readonly Readonly<{ name: string; fields: TableRelationFields<Fields> }>[]
}>>

const OptionalTableRelationsSchema = Schema.optionalKey(TableRelations)

export class TableSnapshot extends Schema.Class<TableSnapshot>("TableSnapshot")({
  name: Schema.String,
  identifier: Schema.String,
  fields: TableFieldsSchema,
  relations: OptionalTableRelationsSchema,
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

class TableDefinitionError extends Schema.TaggedError<TableDefinitionError>()(
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

const isNumericTableScalar = (scalar: TableField["scalar"]) =>
  tableScalarEquals(scalar, "integer") || tableScalarEquals(scalar, "number")

const frozenFields = (fields: ReadonlyArray<string>) => Object.freeze([...fields])

const cloneUnique = (constraint: TableUnique) => {
  const fields = frozenFields(constraint.fields)
  const cloned = TableUnique.make({ name: constraint.name, fields })
  return Object.freeze(cloned)
}

const cloneForeignKey = (constraint: TableForeignKey) => {
  const fields = frozenFields(constraint.fields)
  const referencedFields = frozenFields(constraint.references.fields)

  const reference = TableForeignKeyReference.make({
    table: constraint.references.table,
    fields: referencedFields,
  })

  const references = Object.freeze(reference)
  const cloned = TableForeignKey.make({ name: constraint.name, fields, references })
  return Object.freeze(cloned)
}

const cloneIndex = (index: TableIndex) => {
  const fields = frozenFields(index.fields)
  const cloned = TableIndex.make({ name: index.name, fields })
  return Object.freeze(cloned)
}

const frozenRelations = <A>(relations: ReadonlyArray<A>) => Object.freeze(relations)

const cloneRelations = (relations: TableRelationsInput) => {
  const unique = pipe(Option.fromNullishOr(relations.unique), Option.map(flow(Array.map(cloneUnique), frozenRelations)))
  const foreignKeys = pipe(Option.fromNullishOr(relations.foreignKeys), Option.map(flow(Array.map(cloneForeignKey), frozenRelations)))
  const indexes = pipe(Option.fromNullishOr(relations.indexes), Option.map(flow(Array.map(cloneIndex), frozenRelations)))
  const declared = Record.getSomes({ unique, foreignKeys, indexes })
  const cloned = TableRelations.make(declared)
  return Object.freeze(cloned)
}

const constraintFieldsValid = Effect.fn("Table.constraintFieldsValid")(function* (
  table: string,
  fields: ReadonlyArray<string>,
  available: HashSet.HashSet<string>,
  name: string,
) {
  const trimmedName = name.trim()

  if (Equivalence.strictEqual<number>()(trimmedName.length, 0)) {
    return yield* failTableDefinition(table, "relation constraint name must not be empty")
  }

  if (Array.isReadonlyArrayEmpty(fields)) {
    return yield* failTableDefinition(table, `relation constraint ${name} must declare fields`)
  }

  yield* Effect.reduce(fields, HashSet.empty<string>, Effect.fn("Table.validateRelationField")(function* (seen, field) {
    if (!HashSet.has(available, field)) {
      return yield* failTableDefinition(table, `relation constraint ${name} declares unknown field ${field}`)
    }

    if (HashSet.has(seen, field)) {
      return yield* failTableDefinition(table, `relation constraint ${name} declares duplicate field ${field}`)
    }

    return HashSet.add(seen, field)
  }))
})

const validateLocalRelations = Effect.fn("Table.validateLocalRelations")(function* (
  table: string,
  fields: ReadonlyArray<TableField>,
  relations: Option.Option<TableRelations>,
) {
  if (Option.isNone(relations)) return
  const available = pipe(fields, Array.map(Struct.get("name")), HashSet.fromIterable)
  const constraints = [...relations.value.unique ?? [], ...relations.value.foreignKeys ?? [], ...relations.value.indexes ?? []]

  yield* Effect.reduce(constraints, HashSet.empty<string>, Effect.fn("Table.validateRelation")(function* (seen, constraint) {
    if (HashSet.has(seen, constraint.name)) {
      return yield* failTableDefinition(table, `duplicate relation constraint name ${constraint.name}`)
    }

    yield* constraintFieldsValid(table, constraint.fields, available, constraint.name)
    return HashSet.add(seen, constraint.name)
  }))

  yield* Effect.forEach(relations.value.foreignKeys ?? [], Effect.fn("Table.validateForeignTarget")(function* (constraint) {
    const targetName = constraint.references.table.trim()

    if (Equivalence.strictEqual<number>()(targetName.length, 0)) {
      return yield* failTableDefinition(table, `foreign key constraint ${constraint.name} references an empty table`)
    }

    const targetNames = HashSet.fromIterable(constraint.references.fields)
    yield* constraintFieldsValid(table, constraint.references.fields, targetNames, constraint.name)
  }), { discard: true })

  yield* Effect.forEach(relations.value.indexes ?? [], Effect.fn("Table.validateIndexName")(function* (index) {
    const normalized = index.name.toLowerCase()

    if (normalized.startsWith("sqlite_")) {
      return yield* failTableDefinition(table, `index constraint ${index.name} uses the reserved sqlite_ prefix`)
    }
  }), { discard: true })
})

const commonTableScalar = (
  table: string,
  field: string,
  scalars: ReadonlyArray<TableField["scalar"]>,
) => {
  const first = Array.head(scalars)
  if (Option.isNone(first)) return unsupportedTableScalar(table, field)

  if (Array.every(scalars, (scalar) => tableScalarEquals(first.value, scalar))) {
    return Effect.succeed(first.value)
  }

  return Array.every(scalars, isNumericTableScalar)
    ? Effect.succeed("number" as const)
    : unsupportedTableScalar(table, field)
}

const ownValue = (value: unknown, key: string): Option.Option<unknown> => {
  if (!Predicate.isObject(value)) return Option.none()
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  const property = descriptor?.value
  return Option.fromNullishOr(property)
}

const representationId = (ast: SchemaAST.AST) =>
  pipe(
    ownValue(ast.annotations?.representation, "id"),
    Option.filter(Predicate.isString),
  )

const equals = Equivalence.strictEqual<unknown>()

const integerRepresentation = (
  check: SchemaAST.Filter<unknown> | SchemaAST.FilterGroup<unknown>,
) => equals(check.annotations?.representation?.id, "effect/schema/isInt")

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

const scalarForNumber = (value: number): TableField["scalar"] =>
  Number.isSafeInteger(value) ? "integer" : "number"

const literalTableScalar = (
  table: string,
  field: string,
  literal: SchemaAST.LiteralValue,
) => {
  if (Predicate.isString(literal)) {
    return Effect.succeed("string" as const)
  }

  if (Predicate.isNumber(literal)) {
    const scalar = scalarForNumber(literal)
    return Effect.succeed(scalar)
  }

  return unsupportedTableScalar(table, field)
}

const DateTimeUtcId = "effect/schema/DateTimeUtc"
const dateTimeUtcId = (id: string) => equals(id, DateTimeUtcId)
const stringScalar = Effect.succeed("string" as const)
const integerScalar = Effect.succeed("integer" as const)
const numberScalar = Effect.succeed("number" as const)
const NullableDateTimeUtcFromStringSchema = Schema.NullOr(Schema.DateTimeUtcFromString)
const NullableBooleanFromBitSchema = Schema.NullOr(Schema.BooleanFromBit)
const NoTableChecks: ReadonlyArray<TableCheck> = []
const noTableChecks = Function.constant(NoTableChecks)
const noneLiteralValues = Option.none<ReadonlyArray<string | number>>()
const noLiteralValues = Function.constant(noneLiteralValues)
const trueFlag = (flag: unknown) => equals(flag, true)
const enumValue = ([, value]: SchemaAST.Enum["enums"][number]) => value

const classifyEnumEntry = (
  [, value]: SchemaAST.Enum["enums"][number],
) => Predicate.isString(value) ? "string" : scalarForNumber(value)

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

const normalizedSuspendedAst = (
  ast: SchemaAST.AST,
  suspends: HashSet.HashSet<SchemaAST.Suspend> = HashSet.empty(),
): Option.Option<SchemaAST.AST> => {
  if (!SchemaAST.isSuspend(ast)) return Option.some(ast)
  if (HashSet.has(suspends, ast)) return Option.none()
  const next = ast.thunk()
  const visited = HashSet.add(suspends, ast)
  return normalizedSuspendedAst(next, visited)
}

const evaluateTableScalar = (
  table: string,
  field: string,
  ast: SchemaAST.AST,
  suspends: HashSet.HashSet<SchemaAST.Suspend> = HashSet.empty(),
): Effect.Effect<TableField["scalar"], TableDefinitionError> => {
  if (!SchemaAST.isSuspend(ast)) {
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
      Match.orElse(() => unsupportedTableScalar(table, field)),
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

const numberAt = (payload: unknown, key: string) =>
  pipe(ownValue(payload, key), Option.filter(Predicate.isNumber))

const flagAt = (payload: unknown, key: string) => {
  const value = ownValue(payload, key)
  return Option.exists(value, trueFlag)
}

const greaterThan = (value: number) => GreaterThan.make({ value })
const greaterThanOrEqualTo = (value: number) => GreaterThanOrEqualTo.make({ value })
const lessThan = (value: number) => LessThan.make({ value })
const lessThanOrEqualTo = (value: number) => LessThanOrEqualTo.make({ value })

const singleChecks = (
  key: string,
  make: (value: number) => TableCheck,
) => (payload: unknown): ReadonlyArray<TableCheck> => pipe(
  numberAt(payload, key),
  Option.match({ onNone: noTableChecks, onSome: (value) => [make(value)] }),
)

const betweenChecks = (payload: unknown) => (
  [low, high]: readonly [number, number],
): ReadonlyArray<TableCheck> => {
  const minimumExclusive = flagAt(payload, "exclusiveMinimum")
  const maximumExclusive = flagAt(payload, "exclusiveMaximum")
  const lower = minimumExclusive ? greaterThan(low) : greaterThanOrEqualTo(low)
  const upper = maximumExclusive ? lessThan(high) : lessThanOrEqualTo(high)
  return [lower, upper]
}

const intervalChecks = (payload: unknown) => {
  const minimum = numberAt(payload, "minimum")
  const maximum = numberAt(payload, "maximum")
  return pipe(Option.all([minimum, maximum]), Option.match({ onNone: noTableChecks, onSome: betweenChecks(payload) }))
}

const checkCompilers: Readonly<Record<string, (payload: unknown) => ReadonlyArray<TableCheck>>> = {
  "effect/schema/isGreaterThan": singleChecks("exclusiveMinimum", greaterThan),
  "effect/schema/isGreaterThanOrEqualTo": singleChecks("minimum", greaterThanOrEqualTo),
  "effect/schema/isLessThan": singleChecks("exclusiveMaximum", lessThan),
  "effect/schema/isLessThanOrEqualTo": singleChecks("maximum", lessThanOrEqualTo),
  "effect/schema/isBetween": intervalChecks,
}

const compileTableChecks = (representation: unknown) => (id: string) => pipe(
  Record.get(checkCompilers, id),
  Option.match({
    onNone: noTableChecks,
    onSome: (compile) => pipe(ownValue(representation, "payload"), Option.getOrUndefined, compile),
  }),
)

const tableChecksFromUnknown = (representation: unknown) =>
  pipe(
    ownValue(representation, "id"),
    Option.filter(Predicate.isString),
    Option.match({
      onNone: noTableChecks,
      onSome: compileTableChecks(representation),
    }),
  )

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
  pipe(enumeration.enums, Array.map(enumValue), Option.some)

const literalValuesFromAst = (ast: SchemaAST.AST) =>
  pipe(
    normalizedSuspendedAst(ast),
    Option.flatMap(Function.flow(
        Match.value,
        Match.when(SchemaAST.isLiteral, literalValuesFromLiteral),
        Match.when(SchemaAST.isEnum, literalValuesFromEnum),
        Match.when(SchemaAST.isUnion, (union) => {
          const values: ReadonlyArray<Option.Option<ReadonlyArray<string | number>>> =
            Array.map(union.types, literalValuesFromAst)

          const combined = Option.all(values)
          return Option.map(combined, Array.flatten)
        }),
        Match.orElse(noLiteralValues),
    )),
  )

const nullableAst = (ast: SchemaAST.AST) => {
  if (!SchemaAST.isUnion(ast)) return [ast, false] as const

  const nonNull = Array.filter(ast.types, nonNullAst)
  const reduced = nonNull.length < ast.types.length
  const nullable = reduced && Array.isReadonlyArrayNonEmpty(nonNull)
  if (!nullable) return [ast, false] as const

  const oneMember = equals(nonNull.length, 1)

  const narrowAst = oneMember
    ? Array.headNonEmpty(nonNull)
    : new SchemaAST.Union(nonNull, ast.mode)

  return [narrowAst, true] as const
}

const scalarAst = (
  ast: SchemaAST.AST,
  visited: HashSet.HashSet<SchemaAST.AST> = HashSet.empty(),
  nullable = false,
): Option.Option<readonly [SchemaAST.AST, boolean]> => {
  if (HashSet.has(visited, ast)) return Option.none()

  if (SchemaAST.isSuspend(ast)) {
    const next = ast.thunk()
    const seen = HashSet.add(visited, ast)
    return scalarAst(next, seen, nullable)
  }

  const [physicalAst, containsNull] = nullableAst(ast)
  if (!containsNull) return Option.some([physicalAst, nullable] as const)
  const seen = HashSet.add(visited, ast)
  return scalarAst(physicalAst, seen, true)
}

const orderableUnion = (union: SchemaAST.Union) => Array.every(union.types, orderableAst)

const orderableAst = (ast: SchemaAST.AST): boolean => {
  const codecFree = !ast.encoding

  return codecFree && pipe(
    normalizedSuspendedAst(ast),
    Option.exists((normalized) => {
      const normalizedCodecFree = !normalized.encoding

      const nativeScalar: boolean = pipe(
        Match.value(normalized),
        Match.when(SchemaAST.isUnion, orderableUnion),
        Match.tag("String", "TemplateLiteral", "Number", "Boolean", "Literal", "Enum", Function.constTrue),
        Match.orElse(Function.constFalse),
      )

      return normalizedCodecFree && nativeScalar
    }),
  )
}

const scalarRepresentation = (
  table: string,
  field: string,
  ast: SchemaAST.AST,
) =>
  pipe(
    scalarAst(ast),
    Option.match({
      onNone: () => unsupportedTableScalar(table, field),
      onSome: Effect.succeed,
    }),
  )

const physicalScalar = Effect.fn("Table.physicalScalar")(function* (
  table: string,
  field: string,
  ast: SchemaAST.AST,
) {
  const [physicalAst, nullable] = yield* scalarRepresentation(table, field, ast)
  const scalar = yield* evaluateTableScalar(table, field, physicalAst)
  return { ast: physicalAst, scalar, nullable }
})

const appendOneOf = (checks: ReadonlyArray<TableCheck>) => (values: ReadonlyArray<string | number>) => {
  const oneOf = OneOf.make({ values })
  return Array.append(checks, oneOf)
}

const tableChecks = (ast: SchemaAST.AST, physicalAst: SchemaAST.AST) => {
  const direct = tableChecksFromAst(ast)
  const fromNullable = equals(physicalAst, ast) ? NoTableChecks : tableChecksFromAst(physicalAst)
  const checks = Array.appendAll(direct, fromNullable)

  return pipe(
    literalValuesFromAst(physicalAst),
    Option.match({
      onNone: Function.constant(checks),
      onSome: appendOneOf(checks),
    }),
  )
}

const storageFieldFor = Effect.fn("Table.storageFieldFor")(function* (
  table: string,
  field: string,
  schema: Schema.Constraint,
) {
  const encodedSchema = Schema.toEncoded(schema)
  const [sourceAst, nullable] = yield* scalarRepresentation(table, field, encodedSchema.ast)
  const sourceRepresentation = representationId(sourceAst)
  const automaticUtc = Option.exists(sourceRepresentation, dateTimeUtcId)
  const automaticBoolean = SchemaAST.isBoolean(sourceAst)
  const automatic = automaticBoolean || automaticUtc

  if (!automatic) {
    const scalar = yield* evaluateTableScalar(table, field, sourceAst)

    return {
      storageSchema: schema,
      encodedStorageSchema: encodedSchema,
      storage: { ast: sourceAst, scalar, nullable },
    }
  }

  const typeAst = SchemaAST.toType(schema.ast)
  const normalizedType = scalarAst(typeAst)
  if (Option.isNone(normalizedType)) return yield* unsupportedTableScalar(table, field)
  const [physicalAst, physicalNullable] = normalizedType.value
  const physicalRepresentation = representationId(physicalAst)
  const utc = Option.exists(physicalRepresentation, dateTimeUtcId)
  const booleanAst = SchemaAST.isBoolean(physicalAst)
  const automaticStorage = utc || booleanAst

  if (!automaticStorage) return yield* unsupportedTableScalar(table, field)

  const utcSchema = physicalNullable ? NullableDateTimeUtcFromStringSchema : Schema.DateTimeUtcFromString
  const booleanSchema = physicalNullable ? NullableBooleanFromBitSchema : Schema.BooleanFromBit
  const physicalSchema = utc ? utcSchema : booleanSchema
  const storageSchema = Schema.decodeTo(schema)(physicalSchema)
  const encodedStorageSchema = Schema.toEncoded(storageSchema)
  const stored = yield* physicalScalar(table, field, encodedStorageSchema.ast)
  return { storageSchema, encodedStorageSchema, storage: stored }
})

type CompiledField = Readonly<{
  name: string
  storageSchema: Schema.Constraint
  orderable: boolean
  field: TableField
}>

const storagePair = (entry: Pick<CompiledField, "name" | "storageSchema">) =>
  [entry.name, entry.storageSchema] as const

const columnPair = (entry: Pick<CompiledField, "name" | "storageSchema" | "orderable">) =>
  [entry.name, {
    storageSchema: entry.storageSchema,
    orderable: entry.orderable,
  }] as const

const applyRootChecks = <Fields extends Schema.Struct.Fields>(
  storageSchema: Schema.Struct<Fields>,
) => (checks: SchemaAST.Checks) => storageSchema.check(...checks)

const compileStorageSchema = (
  schema: Schema.Struct<Schema.Struct.Fields>,
  storageEntries: ReadonlyArray<Pick<CompiledField, "name" | "storageSchema">>,
) => {
  const storagePairs = Array.map(storageEntries, storagePair)
  const storageFields = Record.fromEntries(storagePairs)

  return pipe(Schema.Struct(storageFields), (storageSchema) => {
    const typeAst = SchemaAST.toType(schema.ast)
    const rootChecks = Option.fromNullishOr(typeAst.checks)

    return Option.match(rootChecks, {
      onNone: Function.constant(storageSchema),
      onSome: applyRootChecks(storageSchema),
    })
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

export const withImplicitIdentifier = <
  Fields extends Schema.Struct.Fields,
>(schema: Schema.Struct<Fields>) =>
  schema.mapFields(
    (fields) => Struct.assign(fields, DefaultIdentifierFields),
    { unsafePreserveChecks: true },
  )

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
    const storage = yield* storageFieldFor(name, property.name, fieldSchema)

    return {
      name: property.name,
      storageSchema: storage.storageSchema,
      orderable: orderableAst(fieldSchema.ast),
      field: TableField.make({
        name: property.name,
        scalar: storage.storage.scalar,
        nullable: storage.storage.nullable,
        generation: NoGeneration,
        checks: tableChecks(storage.encodedStorageSchema.ast, storage.storage.ast),
      }),
    } satisfies CompiledField
  })

  const compiledFields = yield* Effect.forEach(
    encodedSchema.ast.propertySignatures,
    compileField,
  )

  const fields = Array.map(compiledFields, Struct.get("field"))
  const columns = pipe(compiledFields, Array.map(columnPair), Record.fromEntries)

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
  const nullableIdentifier = Option.filter(identifierField, (compiled) => compiled.field.nullable)

  if (Option.isSome(nullableIdentifier)) {
    return yield* failTableDefinition(name, `identifier field ${nullableIdentifier.value.name} must not encode to null`)
  }

  if (Option.isSome(identifierField)) {
    const source = Option.fromNullishOr(
      schema.fields[identifierField.value.name as Extract<keyof S["fields"], string>],
    )

    const identifierSchema = Option.getOrThrow(source)
    const storageSchema = compileStorageSchema(schema, compiledFields)

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
      columns,
    }
  }

  const isNamedId = (field: TableField) => equals(field.name, "id")
  const idIsReserved = Array.some(fields, isNamedId)

  if (idIsReserved) {
    return yield* failTableDefinition(
      name,
      "field id must use Domain.identifier when overriding the default UUIDv7 identifier",
    )
  }

  const rowSchema = withImplicitIdentifier(schema)
  const { storageSchema: identifierStorageSchema } = yield* storageFieldFor(name, "id", rowSchema.fields.id)

  const storageEntriesWithIdentifier = Array.prepend(compiledFields, {
    name: "id",
    storageSchema: identifierStorageSchema,
  })

  const columnsWithDefaultIdentifier = Record.set(columns, "id", {
    storageSchema: identifierStorageSchema,
    orderable: true,
  })

  const insertSchema = compileStorageSchema(schema, compiledFields)
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
    columns: columnsWithDefaultIdentifier,
  }
})

type EncodedRecord = Readonly<Record<string, unknown>>

type InsertSchema<S extends Schema.Struct<Schema.Struct.Fields>> = Schema.Codec<
  S["Type"],
  EncodedRecord,
  S["DecodingServices"],
  S["EncodingServices"]
>

type StoredRowSchema<Row extends Schema.Struct<Schema.Struct.Fields>> = Schema.Codec<
  Row["Type"],
  EncodedRecord,
  Row["DecodingServices"],
  Row["EncodingServices"]
>

type IdentifierStorageSchema<Identifier extends Schema.Constraint> = Schema.Codec<
  Identifier["Type"],
  unknown,
  Identifier["DecodingServices"],
  Identifier["EncodingServices"]
>

export interface Table<
  Name extends string = string,
  Row extends Schema.Struct<Schema.Struct.Fields> = Schema.Struct<Schema.Struct.Fields>,
  Insert extends Schema.Constraint = Schema.Codec<unknown, unknown, unknown, unknown>,
  Storage extends Schema.Constraint = Schema.Codec<unknown, unknown, unknown, unknown>,
  Key extends string = string,
  Identifier extends Schema.Constraint = Schema.Constraint,
  IdentifierStorage extends Schema.Constraint = Schema.Constraint,
  Columns extends Readonly<Record<string, TableColumn>> = Readonly<Record<string, TableColumn>>,
> extends Readonly<Partial<{ relations: TableRelations }>> {
  readonly name: Name
  readonly schema: Schema.Struct<Schema.Struct.Fields>
  readonly rowSchema: Row
  readonly insertSchema: Insert
  readonly storageSchema: Storage
  readonly identifier: Key
  readonly identifierSchema: Identifier
  readonly identifierStorageSchema: IdentifierStorage
  readonly fields: ReadonlyArray<TableField>
  readonly columns: Columns
}

export type TableFieldName<S extends Schema.Struct<Schema.Struct.Fields>> =
  Extract<keyof RowSchema<S>["fields"], string>

const make = <
  const Name extends string,
  const S extends Schema.Struct<Schema.Struct.Fields>,
>(
  options: Readonly<{
    name: Name
    schema: S
  }> & Readonly<Partial<{
    relations: TableRelationsInput<TableFieldName<S>>
  }>>,
): Table<
  Name,
  RowSchema<S>,
  InsertSchema<S>,
  StoredRowSchema<RowSchema<S>>,
  [IdentifierName<S>] extends [never] ? "id" : IdentifierName<S>,
  IdentifierSchema<S>,
  IdentifierStorageSchema<IdentifierSchema<S>>,
  TableColumns<RowSchema<S>["fields"]>
> => {
  const result = pipe(
    compileTable(options.name, options.schema),
    Effect.runSync,
  )

  const relations = pipe(Option.fromNullishOr(options.relations), Option.map(cloneRelations))
  pipe(validateLocalRelations(result.name, result.fields, relations), Effect.runSync)
  const declared: Readonly<Partial<Pick<Table, "relations">>> = Record.getSomes({ relations })

  return Struct.assign(result, declared) as typeof result & Table<
    Name,
    RowSchema<S>,
    InsertSchema<S>,
    StoredRowSchema<RowSchema<S>>,
    [IdentifierName<S>] extends [never] ? "id" : IdentifierName<S>,
    IdentifierSchema<S>,
    IdentifierStorageSchema<IdentifierSchema<S>>,
    TableColumns<RowSchema<S>["fields"]>
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
  const relations = pipe(Option.fromNullishOr(table.relations), Option.map(cloneRelations))
  const declared = Record.getSomes({ relations })

  return TableSnapshot.make({
    name: table.name,
    identifier: table.identifier,
    fields,
    ...declared,
  })
}

const fieldsEqual = Equivalence.Array(Equivalence.strictEqual<string>())

const compatibleForeignKeyScalars = (
  source: TableField["scalar"],
  target: TableField["scalar"],
) => {
  const same = tableScalarEquals(source, target)
  const bothNumeric = isNumericTableScalar(source) && isNumericTableScalar(target)
  return same || bothNumeric
}

const fieldPair = (field: TableField) => [field.name, field] as const
const tablePair = (table: TableSnapshot) => [table.name, table] as const

const validateRelations = Effect.fn("Table.validateRelations")(function* (tables: ReadonlyArray<TableSnapshot>) {
  const tableByName = pipe(tables, Array.map(tablePair), HashMap.fromIterable)

  const tableNames = yield* Effect.reduce(tables, HashSet.empty<string>, Effect.fn("Table.validateRelationTable")(function* (seen, table) {
    const normalizedName = table.name.toLowerCase()

    if (HashSet.has(seen, normalizedName)) {
      return yield* failTableDefinition(table.name, `duplicate table ${table.name}`)
    }

    const relations = Option.fromNullishOr(table.relations)
    yield* validateLocalRelations(table.name, table.fields, relations)
    return HashSet.add(seen, normalizedName)
  }))

  yield* Effect.reduce(tables, HashSet.empty<string>, Effect.fn("Table.validateSchemaIndexes")(function* (seen, table) {
    return yield* Effect.reduce(table.relations?.indexes ?? [], Function.constant(seen), Effect.fn("Table.validateSchemaIndex")(function* (indexNames, index) {
      const indexName = index.name.toLowerCase()

      if (HashSet.has(tableNames, indexName)) {
        return yield* failTableDefinition(table.name, `index constraint ${index.name} collides with a table name`)
      }

      if (HashSet.has(indexNames, indexName)) {
        return yield* failTableDefinition(table.name, `duplicate index constraint name ${index.name}`)
      }

      return HashSet.add(indexNames, indexName)
    }))
  }))

  yield* Effect.forEach(tables, Effect.fn("Table.validateForeignKeys")(function* (table) {
    const sourceFields = pipe(table.fields, Array.map(fieldPair), HashMap.fromIterable)

    yield* Effect.forEach(table.relations?.foreignKeys ?? [], Effect.fn("Table.validateForeignKey")(function* (foreignKey) {
      const target = HashMap.get(tableByName, foreignKey.references.table)

      if (Option.isNone(target)) {
        return yield* failTableDefinition(table.name, `foreign key constraint ${foreignKey.name} references unknown table ${foreignKey.references.table}`)
      }

      const sameArity = Equivalence.strictEqual<number>()(foreignKey.fields.length, foreignKey.references.fields.length)

      if (!sameArity) {
        return yield* failTableDefinition(table.name, `foreign key constraint ${foreignKey.name} has incompatible source and target arity`)
      }

      const targetFields = pipe(target.value.fields, Array.map(fieldPair), HashMap.fromIterable)
      const targetIsIdentifier = fieldsEqual(foreignKey.references.fields, [target.value.identifier])
      const matchesUnique = (unique: TableUnique) => fieldsEqual(unique.fields, foreignKey.references.fields)
      const targetIsUnique = Array.some(target.value.relations?.unique ?? [], matchesUnique)
      const uniqueTarget = targetIsIdentifier || targetIsUnique

      if (!uniqueTarget) {
        return yield* failTableDefinition(table.name, `foreign key constraint ${foreignKey.name} must reference the primary key or a declared unique tuple of ${target.value.name}`)
      }

      const pairs = Array.zip(foreignKey.fields, foreignKey.references.fields)

      yield* Effect.forEach(pairs, Effect.fn("Table.validateForeignKeyPair")(function* ([sourceName, targetName]) {
        const source = HashMap.get(sourceFields, sourceName)
        const targetField = HashMap.get(targetFields, targetName)
        const missingField = Option.isNone(source) || Option.isNone(targetField)

        if (missingField) {
          return yield* failTableDefinition(table.name, `foreign key constraint ${foreignKey.name} references unknown field ${sourceName} or ${targetName}`)
        }

        if (!compatibleForeignKeyScalars(source.value.scalar, targetField.value.scalar)) {
          return yield* failTableDefinition(table.name, `foreign key constraint ${foreignKey.name} has incompatible field types ${sourceName} and ${target.value.name}.${targetName}`)
        }
      }), { discard: true })
    }), { discard: true })
  }), { discard: true })
})

export const Table = { make, snapshot, validateRelations }
