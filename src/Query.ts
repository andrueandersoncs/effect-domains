import { Effect, Schema } from "effect"
import type { AnyTableDefinition } from "./Table.ts"

type AnySchema = Schema.Constraint

/**

Use when: typing a query configuration because its boundary schemas and
implementation form one operation contract.

Example: annotate reusable configuration passed to `Query.make`.

**/
export interface QueryConfig<
  Request extends AnySchema,
  Result extends AnySchema,
  E,
  R,
> {
  readonly Request: Request
  readonly Result: Result
  readonly implementation: (
    request: Request["Encoded"],
  ) => Effect.Effect<unknown, E, R>
}

/**

Use when: storing or inspecting a query because it keeps its table, schemas,
and executable operation together.

Example: call `query.execute(request)` on a query definition.

**/
export class QueryDefinition<
  T extends AnyTableDefinition,
  Request extends AnySchema,
  Result extends AnySchema,
  E,
  R,
> {
  constructor(
    readonly table: T,
    readonly Request: Request,
    readonly Result: Result,
    readonly implementation: QueryConfig<Request, Result, E, R>["implementation"],
  ) {}

  readonly execute = Effect.fn("Query.execute")(
    { self: this },
    function* (
      this: QueryDefinition<T, Request, Result, E, R>,
      request: Request["Type"],
    ) {
      const encoded = yield* Schema.encodeEffect(this.Request)(request)
      const result = yield* this.implementation(encoded)
      return yield* Schema.decodeUnknownEffect(this.Result)(result)
    },
  )
}

/**

Use when: defining an authored operation because `make` preserves its table,
boundary schemas, and implementation.

Example: `Query.make(Books, queryConfig)` defines one query.

**/
export abstract class Query {
  static make<
    const T extends AnyTableDefinition,
    const Request extends AnySchema,
    const Result extends AnySchema,
    E,
    R,
  >(
    table: T,
    config: QueryConfig<Request, Result, E, R>,
  ): QueryDefinition<T, Request, Result, E, R> {
    return new QueryDefinition(
      table,
      config.Request,
      config.Result,
      config.implementation,
    )
  }
}
