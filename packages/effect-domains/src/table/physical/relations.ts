import { Schema } from "effect"

const RelationFieldsSchema = Schema.Array(Schema.String)

export class TableUnique extends Schema.Class<TableUnique>("TableUnique")({
  name: Schema.String,
  fields: RelationFieldsSchema,
}) {}

export class TableForeignKeyReference extends Schema.Class<TableForeignKeyReference>(
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

