import { Effect, Schema } from "effect"
import { tableName } from "./algorithms.ts"
import type { TableError } from "./errors.ts"
import type { TableStore } from "./services.ts"

/**
 *
 * Scope: public
 *
 * When to use: Runtime code must inspect compiled metadata because table
 * creation belongs to a runtime adapter.
 *
 * Example:
 * ```ts
 * import { Schema } from "effect"
 * import { Table } from "effect-domains/table"
 *
 * const Books = Table.make({ name: "books", schema: Schema.Struct({ title: Schema.String }) })
 * const value = Books.fields
 * ```
 *
 */
export interface TableDefinition<
  Name extends string,
  S extends Schema.Struct<Schema.Struct.Fields>,
  K extends string,
  Row extends Schema.Struct<Schema.Struct.Fields>,
  IdentifierSchema extends Schema.Constraint,
> {
  readonly name: Name
  readonly schema: S
  readonly rowSchema: Row
  readonly identifier: K
  readonly identifierSchema: IdentifierSchema
  readonly fields: ReadonlyArray<Readonly<{
    _tag: "TableField"
    name: string
    scalar: "string" | "number"
    generation: import("effect").Option.Option<"uuidv7">
  }>>
  readonly write: () => Effect.Effect<void, TableError, TableStore>
}

const makeTable = <
  const Name extends string,
  const S extends Schema.Struct<Schema.Struct.Fields>,
>(
  {
    name,
    schema,
  }: Readonly<{
    name: Name
    schema: S
  }>,
) => tableName(name, schema)

/**
 *
 * Scope: public
 *
 * When to use: A canonical struct needs table metadata because persistence
 * mappings may only be mechanical and lossless.
 *
 * Example:
 * ```ts
 * import { Schema } from "effect"
 * import { Table } from "effect-domains/table"
 *
 * const Books = Table.make({ name: "books", schema: Schema.Struct({ title: Schema.String }) })
 * ```
 *
 */
export class Table {
  private constructor() {}

  static make = makeTable
}
