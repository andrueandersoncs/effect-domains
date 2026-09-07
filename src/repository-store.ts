import { Context, Effect, Option, Schema } from "effect"
import type { Table } from "./table.ts"

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
  readonly insert: (table: Table, value: Readonly<Record<string, unknown>>) => Effect.Effect<unknown, RepositoryError>
  readonly update: (table: Table, value: Readonly<Record<string, unknown>>) => Effect.Effect<Option.Option<unknown>, RepositoryError>
  readonly remove: (table: Table, key: unknown) => Effect.Effect<boolean, RepositoryError>
}>()("@effect-domains/RepositoryStore") {}
