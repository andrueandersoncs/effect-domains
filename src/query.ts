import { Effect, Schema, Struct } from "effect"
import { Table } from "./table.ts"

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
