import { Effect, Schema, Struct } from "effect"
import { Table } from "./table.ts"

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
export class Query extends Schema.Class<Query>("Query")({
  table: Schema.Any,
  Request: Schema.Any,
  Result: Schema.Any,
  implementation: Schema.Any,
}) {
  static override make<
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
    const { table, Request, Result, implementation } = options

    const execute = Effect.fn("Query.execute")(function* (
      request: Request["Type"],
    ) {
      const encoded = yield* Schema.encodeEffect(Request)(request)
      const implemented = yield* implementation(encoded)

      return yield* Schema.decodeUnknownEffect(Result)(implemented)
    })

    return Struct.assign(
      super.make({
        table,
        Request,
        Result,
        implementation,
      }),
      { execute },
    ) as {
      readonly table: Table
      readonly Request: Request
      readonly Result: Result
      readonly implementation: typeof implementation
      readonly execute: typeof execute
    }
  }
}
