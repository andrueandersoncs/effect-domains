export {
  GreaterThan,
  GreaterThanOrEqualTo,
  LessThan,
  LessThanOrEqualTo,
  MaxLength,
  MinLength,
  OneOf,
  type TableCheck,
  TableCheckSchema,
  TableField,
  TableForeignKey,
  TableIndex,
  type TableRelationsInput,
  TableSnapshot,
  TableUnique,
} from "./table-model.ts"

export { withImplicitIdentifier } from "./table-compiler.ts"

import type { Table as TableDefinition, TableFieldName } from "./table-relations.ts"

export type { TableFieldName }

export type Table = TableDefinition

import { project, reference } from "./table-projection.ts"
import { make, snapshot, validateRelations } from "./table-relations.ts"

export const Table = { make, reference, project, snapshot, validateRelations }
