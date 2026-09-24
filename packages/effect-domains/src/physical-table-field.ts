import { Schema } from "effect"
import { TableCheckSchema } from "./table-check-model.ts"

const TableScalarSchema = Schema.Literals(["string", "integer", "number"])
const UuidV7GenerationSchema = Schema.Literal("uuidv7")
const OptionalUuidV7GenerationSchema = Schema.Option(UuidV7GenerationSchema)
const TableChecksSchema = Schema.Array(TableCheckSchema)

export class TableField extends Schema.TaggedClass<TableField>()("TableField", {
  name: Schema.String,
  scalar: TableScalarSchema,
  nullable: Schema.Boolean,
  generation: OptionalUuidV7GenerationSchema,
  checks: TableChecksSchema,
}) {}
