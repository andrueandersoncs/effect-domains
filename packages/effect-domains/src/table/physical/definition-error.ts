import { Schema } from "effect"

export class TableDefinitionError extends Schema.TaggedError<TableDefinitionError>()(
  "TableDefinitionError",
  { table: Schema.String, reason: Schema.String },
) {}

