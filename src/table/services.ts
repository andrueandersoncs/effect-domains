import { Context, Effect, Schema } from "effect"
import type { TableDefinition } from "./types.ts"
import type { TableError } from "./errors.ts"

/**
 *
 * Scope: public
 *
 * When to use: A runtime adapter must implement physical table creation for
 * compiled table definitions because effects require a narrow runtime boundary.
 *
 * Example:
 * ```ts
 * import { Effect } from "effect"
 * import { TableStore } from "effect-domains/table/services"
 *
 * const store = TableStore.of({ write: () => Effect.void })
 * ```
 *
 */
export class TableStore extends Context.Service<TableStore, {
  readonly write: (
    table: TableDefinition<
      string,
      Schema.Struct<Schema.Struct.Fields>,
      string,
      Schema.Struct<Schema.Struct.Fields>,
      Schema.Constraint
    >,
  ) => Effect.Effect<void, TableError>
}>()("@effect-domains/TableStore") {}
