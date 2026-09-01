import { Schema } from "effect"

/**
 *
 * Scope: public
 *
 * When to use: Table field metadata needs a scalar schema because adapters
 * support only string and number columns.
 *
 * Example:
 * ```ts
 * import { TableFieldScalarSchema } from "./schemas.ts"
 *
 * const value = TableFieldScalarSchema.make("string")
 * ```
 *
 */
export const TableFieldScalarSchema = Schema.Literals(["string", "number"])

const UuidV7GenerationSchema = Schema.Literal("uuidv7")

/**
 *
 * Scope: public
 *
 * When to use: Table field metadata needs generation schema because only UUIDv7
 * is mechanically generated.
 *
 * Example:
 * ```ts
 * import { Option } from "effect"
 * import { TableFieldGenerationSchema } from "./schemas.ts"
 *
 * const value = TableFieldGenerationSchema.make(Option.none())
 * ```
 *
 */
export const TableFieldGenerationSchema = Schema.Option(
  UuidV7GenerationSchema,
)
