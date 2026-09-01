import { Schema } from "effect"
import { CreateTableOperationSchema } from "./schemas.ts"

/**
 *
 * Scope: public
 *
 * When to use: Table metadata validation must report why a canonical schema
 * cannot produce a physical table because invalid derivation must stop before
 * database work.
 *
 * Example:
 * ```ts
 * import { TableDefinitionError } from "effect-domains/table/errors"
 *
 * const error = new TableDefinitionError("books", "schema must encode to a flat struct")
 * ```
 *
 */
export class TableDefinitionError extends Schema.TaggedError<TableDefinitionError>()(
  "TableDefinitionError",
  {
    table: Schema.String,
    reason: Schema.String,
  },
) {
  constructor(table: string, reason: string) {
    super({ table, reason })
  }

  override get message(): string {
    return `Invalid table definition for ${this.table}: ${this.reason}`
  }
}

/**
 *
 * Scope: public
 *
 * When to use: A table adapter must preserve a failed physical table-creation
 * operation in its Effect error channel because callers need the original
 * database cause.
 *
 * Example:
 * ```ts
 * import { TableError } from "effect-domains/table/errors"
 *
 * const error = new TableError("books", new Error("database unavailable"))
 * ```
 *
 */
export class TableError extends Schema.TaggedError<TableError>()(
  "TableError",
  {
    operation: CreateTableOperationSchema,
    table: Schema.String,
    cause: Schema.Unknown,
  },
) {
  constructor(table: string, cause: unknown) {
    super({ operation: "createTable", table, cause })
  }

  override get message(): string {
    return `Table creation failed for ${this.table}`
  }
}
