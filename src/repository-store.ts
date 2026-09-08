import { Context, Effect, Option, Schema } from "effect"
import type { Table } from "./table.ts"

export interface RepositoryListOrder {
  readonly field: string
  readonly direction: "asc" | "desc"
}

export interface RepositoryListQuery {
  readonly filter: Readonly<Record<string, unknown>>
  readonly order: ReadonlyArray<RepositoryListOrder>
  readonly cursor: Readonly<{ readonly values: ReadonlyArray<unknown>; readonly identifier: unknown }> | undefined
  readonly limit: number
}

export interface RepositoryListPage {
  readonly rows: ReadonlyArray<unknown>
  readonly hasMore: boolean
}

const RepositoryErrorCauseSchema = Schema.Defect()

export class RepositoryError extends Schema.TaggedError<RepositoryError>()(
  "RepositoryError",
  { resource: Schema.String, cause: RepositoryErrorCauseSchema },
) {
  override get message() {
    return `Persistence failed for ${this.resource}`
  }
}

export class ResourceNotFound extends Schema.TaggedError<ResourceNotFound>()(
  "ResourceNotFound",
  { resource: Schema.String, key: Schema.String },
) {
  override get message() {
    return `${this.resource} has no record with key ${this.key}`
  }
}

export class RepositoryStore extends Context.Service<RepositoryStore, {
  readonly find: (table: Table, key: unknown) => Effect.Effect<Option.Option<unknown>, RepositoryError>
  readonly list: (table: Table) => Effect.Effect<ReadonlyArray<unknown>, RepositoryError>
  readonly query: (
    table: Table,
    query: RepositoryListQuery,
  ) => Effect.Effect<RepositoryListPage, RepositoryError>
  readonly insert: (table: Table, value: Readonly<Record<string, unknown>>) => Effect.Effect<unknown, RepositoryError>
  readonly update: (table: Table, value: Readonly<Record<string, unknown>>) => Effect.Effect<Option.Option<unknown>, RepositoryError>
  readonly remove: (table: Table, key: unknown) => Effect.Effect<boolean, RepositoryError>
  readonly transaction: <A, E, R>(
    table: Table,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | RepositoryError, R>
}>()("@effect-domains/RepositoryStore") {}
