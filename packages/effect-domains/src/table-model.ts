import { Array, Data, Effect, Equivalence, Function, HashSet, Option, Record, Schema, Struct, flow, pipe } from "effect"
import { type StructSchema, UuidV7Schema } from "./domain.ts"
import type { Table } from "./table-relations.ts"

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

export const isOneOfCheck = (check: TableCheck): check is OneOf =>
  Equivalence.strictEqual<TableCheck["_tag"]>()(check._tag, "OneOf")

export const isTrue = (value: boolean): value is true => value

const TableChecksSchema = Schema.Array(TableCheckSchema)

export class TableField extends Schema.TaggedClass<TableField>()("TableField", {
  name: Schema.String,
  scalar: TableScalarSchema,
  nullable: Schema.Boolean,
  generation: OptionalUuidV7GenerationSchema,
  checks: TableChecksSchema,
}) {}

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

export class TableDefinitionError extends Schema.TaggedError<TableDefinitionError>()(
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

export {
  DefaultIdentifierField,
  DefaultIdentifierFields,
  emptyNames,
  failTableDefinition,
  NoGeneration,
  numericScalar,
  TableForeignKeyReference,
  TableRelations,
  type TableReference,
  unsupportedTableScalar,
  validateLocalRelations,
}
