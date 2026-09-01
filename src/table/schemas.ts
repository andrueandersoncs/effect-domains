import { Schema } from "effect"
import { uuidV7Check } from "../table-identifier/constants.ts"
import { TableFieldFields } from "../table-field/constants.ts"

/**
 *
 * Scope: public
 *
 * When to use: An operation must accept generated identity because a table
 * without domain identity receives a physical UUIDv7 field.
 *
 * Example:
 * ```ts
 * import { Schema } from "effect"
 * import { DefaultTableIdentifierSchema } from "effect-domains/table/schemas"
 *
 * const decodeIdentifier = Schema.decodeUnknownEffect(DefaultTableIdentifierSchema)
 * ```
 *
 */
export const DefaultTableIdentifierSchema = Schema.String.check(uuidV7Check)

/**
 *
 * Scope: public
 *
 * When to use: A typed table failure needs its operation tag because callers
 * may handle several persistence operations.
 *
 * Example:
 * ```ts
 * import { CreateTableOperationSchema } from "effect-domains/table/schemas"
 *
 * const value = CreateTableOperationSchema.make("createTable")
 * ```
 *
 */
export const CreateTableOperationSchema = Schema.Literal("createTable")

/**
 *
 * Scope: public
 *
 * When to use: Adapter metadata needs a validated physical field because table
 * rendering accepts only supported scalar columns.
 *
 * Example:
 * ```ts
 * import { Option } from "effect"
 * import { TableFieldSchema } from "effect-domains/table/schemas"
 *
 * const title = TableFieldSchema.make({ name: "title", scalar: "string", generation: Option.none() })
 * ```
 *
 */
export const TableFieldSchema = Schema.TaggedStruct(
  "TableField",
  TableFieldFields,
)

/**
 *
 * Scope: public
 *
 * When to use: Adapter code needs tagged field metadata because physical column
 * records form an independently evolving boundary.
 *
 * Example:
 * ```ts
 * import type { TableField } from "effect-domains/table/schemas"
 *
 * const render = (field: TableField) => field.name
 * ```
 *
 */
export interface TableField extends Schema.Schema.Type<typeof TableFieldSchema> {
  readonly _tag: "TableField"
}
