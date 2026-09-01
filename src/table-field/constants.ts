import { Function, Schema } from "effect"
import {
  TableFieldGenerationSchema,
  TableFieldScalarSchema,
} from "./schemas.ts"

/**
 *
 * Scope: public
 *
 * When to use: Table field schemas need a stable field map because adapter
 * metadata is validated as one record.
 *
 * Example:
 * ```ts
 * import { TableFieldFields } from "./constants.ts"
 *
 * const value = TableFieldFields.name
 * ```
 *
 */
export const TableFieldFields = Function.identity({
  name: Schema.String,
  scalar: TableFieldScalarSchema,
  generation: TableFieldGenerationSchema,
})
