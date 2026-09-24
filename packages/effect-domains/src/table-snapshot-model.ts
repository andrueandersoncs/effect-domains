import { Schema } from "effect"
import { TableField } from "./physical-table-field.ts"
import { TableRelations } from "./physical-table-relations.ts"

const TableFieldsSchema = Schema.Array(TableField)
const OptionalTableRelationsSchema = Schema.optionalKey(TableRelations)

export class TableSnapshot extends Schema.Class<TableSnapshot>("TableSnapshot")({
  name: Schema.String,
  identifier: Schema.String,
  fields: TableFieldsSchema,
  relations: OptionalTableRelationsSchema,
}) {}
