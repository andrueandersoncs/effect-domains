import { Context, Data, Effect, Option, Schema } from "effect"
import { Policy } from "./policy.ts"
import type { Table } from "./table.ts"

/** Physical, already encoded values. This is a privileged storage boundary. */
export class RepositorySelect extends Data.Class<{
  readonly filter: Readonly<Record<string, unknown>>
  readonly after: Option.Option<unknown>
  readonly limit: number
}> {}

export class RepositoryAccess extends Data.Class<{
  readonly policy: Policy
  readonly subject: Readonly<Record<string, unknown>>
}> {}

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
  readonly select: (
    table: Table,
    query: RepositorySelect,
    access: RepositoryAccess,
  ) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, RepositoryError>
  readonly insert: (table: Table, value: Readonly<Record<string, unknown>>) => Effect.Effect<unknown, RepositoryError>
  readonly update: (
    table: Table,
    value: Readonly<Record<string, unknown>>,
    access: RepositoryAccess,
  ) => Effect.Effect<Option.Option<unknown>, RepositoryError>
  readonly remove: (
    table: Table,
    key: unknown,
    access: RepositoryAccess,
  ) => Effect.Effect<boolean, RepositoryError>
  readonly transaction: <A, E, R>(
    table: Table,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | RepositoryError, R>
}>()("@effect-domains/RepositoryStore") {}
