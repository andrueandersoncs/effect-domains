import { Effect, Schema } from "effect"
import { queryFromTable } from "./algorithms.ts"
import type { TableDefinition } from "../table/types.ts"

/**
 *
 * Scope: public
 *
 * When to use: Runtime code needs an inspectable authored operation because
 * schemas must guard both sides of its implementation.
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
export interface QueryDefinition<
  T extends TableDefinition<
    string,
    Schema.Struct<Schema.Struct.Fields>,
    string,
    Schema.Struct<Schema.Struct.Fields>,
    Schema.Constraint
  >,
  Request extends Schema.Constraint,
  Result extends Schema.Constraint,
  E,
  R,
> {
  readonly table: T
  readonly Request: Request
  readonly Result: Result
  readonly implementation: (
    request: Request["Encoded"],
  ) => Effect.Effect<unknown, E, R>
  readonly execute: (
    request: Request["Type"],
  ) => Effect.Effect<Result["Type"], E | Schema.SchemaError, R | Request["EncodingServices"] | Result["DecodingServices"]>
}

const makeQuery = <
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
  {
    table,
    Request,
    Result,
    implementation,
  }: Readonly<{
    table: Table
    Request: Request
    Result: Result
    implementation: (
      request: Request["Encoded"],
    ) => Effect.Effect<unknown, E, R>
  }>,
) => queryFromTable(table, Request, Result, implementation)

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

  static make = makeQuery
}
