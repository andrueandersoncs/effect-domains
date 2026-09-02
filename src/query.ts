import { Effect, Function, Schema } from "effect"
import type { TableDefinition } from "./table.ts"

const queryFromTable = <
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
) => {
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

/**
 *
 * Scope: public
 *
 * When to use: One authored operation needs an inspectable contract because its
 * request and result cross encoded boundaries.
 *
 * Example:
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Query } from "effect-domains/query"
 * import { Table } from "effect-domains/table"
 *
 * const Records = Table.make({ name: "records", schema: Schema.Struct({ value: Schema.String }) })
 * const Echo = Query.make({ table: Records, Request: Schema.String, Result: Schema.String, implementation: (value) => Effect.succeed(value) })
 * ```
 *
 */
export class Query {
  private constructor() {}

  static make<
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
    options: Readonly<{
      table: Table
      Request: Request
      Result: Result
      implementation: (
        request: Request["Encoded"],
      ) => Effect.Effect<unknown, E, R>
    }>,
  ) {
    return queryFromTable(
      options.table,
      options.Request,
      options.Result,
      options.implementation,
    )
  }
}
