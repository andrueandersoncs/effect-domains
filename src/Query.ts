import { Effect, Schema } from "effect"
import type { AnyTableDefinition } from "./Table.ts"

type AnySchema = Schema.Constraint

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

  readonly execute = (request: Request["Type"]): Effect.Effect<
    Result["Type"],
    E | Schema.SchemaError,
    | R
    | Request["EncodingServices"]
    | Result["DecodingServices"]
  > =>
    Effect.flatMap(
      Effect.flatMap(
        Schema.encodeEffect(this.Request)(request),
        this.implementation,
      ),
      Schema.decodeUnknownEffect(this.Result),
    )
}

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
