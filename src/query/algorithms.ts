import { Effect, Function, Schema } from "effect"
import type { TableDefinition } from "../table/types.ts"
import type { QueryDefinition } from "./types.ts"

/**
 *
 * Scope: public
 *
 * When to use: One authored database operation needs a contract because its
 * request and result cross encoded boundaries.
 *
 * Example:
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { queryFromTable } from "./algorithms.ts"
 * import { Table } from "effect-domains/table"
 *
 * const Records = Table.make({ name: "records", schema: Schema.Struct({ value: Schema.String }) })
 * const Echo = queryFromTable(Records, Schema.String, Schema.String, (value) => Effect.succeed(value))
 * ```
 *
 */
export const queryFromTable = <
  const Table extends TableDefinition<
    string,
    Schema.Struct<Schema.Struct.Fields>,
    string,
    Schema.Struct<Schema.Struct.Fields>,
    Schema.Constraint
  >,
  const Request extends Schema.Constraint,
  const Result extends Schema.Constraint,
  E,
  R,
>(
  table: Table,
  Request: Request,
  Result: Result,
  implementation: (
    request: Request["Encoded"],
  ) => Effect.Effect<unknown, E, R>,
): QueryDefinition<Table, Request, Result, E, R> => {
  const execute = Effect.fn("Query.execute")(function* (
    request: Request["Type"],
  ) {
    const encoded = yield* Schema.encodeEffect(Request)(request)
    const implemented = yield* implementation(encoded)

    return yield* Schema.decodeUnknownEffect(Result)(implemented)
  })

  return Function.identity({
    table,
    Request,
    Result,
    implementation,
    execute,
  })
}
