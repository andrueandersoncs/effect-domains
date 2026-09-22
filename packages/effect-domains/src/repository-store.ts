import { Context, Data, Effect, Option, Schema } from "effect"
import { Policy } from "./policy.ts"
import type { Table } from "./table.ts"


export class RepositoryOrder extends Data.Class<{
  readonly field: string
  readonly direction: "asc" | "desc"
}> {}

/**
 * Physical, already encoded values. This is a privileged storage boundary.
 *
 * `order` is the complete ordering, ending with the identifier so it is total.
 * `after` carries the physical values of every `order` field from the last row
 * of the previous page; the store continues strictly after that row (keyset).
 */
export class RepositorySelect extends Data.Class<{
  readonly filter: Readonly<Record<string, unknown>>
  readonly range: Readonly<Record<string, Readonly<Partial<{ from: unknown; to: unknown }>>>>
  readonly order: ReadonlyArray<RepositoryOrder>
  readonly after: Option.Option<Readonly<Record<string, unknown>>>
  readonly limit: number
}> {}

export class RepositoryAccess extends Data.Class<{
  readonly policy: Policy
  readonly subject: Readonly<Record<string, unknown>>
}> {}


export class RepositoryError extends Schema.TaggedError<RepositoryError>()(
  "RepositoryError",
  { resource: Schema.String },
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


export class UniqueViolation extends Schema.TaggedError<UniqueViolation>()(
  "UniqueViolation",
  { resource: Schema.String },
) {
  override get message() {
    return `${this.resource} already has a record with those values`
  }
}

/** The row's declared version field no longer equals the version the writer read. */
export class VersionConflict extends Schema.TaggedError<VersionConflict>()(
  "VersionConflict",
  { resource: Schema.String, key: Schema.String, expectedVersion: Schema.Int },
) {
  override get message() {
    return `${this.resource} ${this.key} is no longer at version ${this.expectedVersion}`
  }
}

type RepositoryUpdate = {
  (
    table: Table,
    value: Readonly<Record<string, unknown>>,
    access: RepositoryAccess,
  ): Effect.Effect<Option.Option<unknown>, RepositoryError | UniqueViolation>;
  (
    table: Table,
    value: Readonly<Record<string, unknown>>,
    access: RepositoryAccess,
    guard: Readonly<Record<string, unknown>>,
  ): Effect.Effect<Option.Option<unknown>, RepositoryError | UniqueViolation>;
}

export class RepositoryStore extends Context.Service<RepositoryStore, {
  readonly select: (
    table: Table,
    query: RepositorySelect,
    access: RepositoryAccess,
  ) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, RepositoryError>
  readonly insert: (
    table: Table,
    value: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, RepositoryError | UniqueViolation>
  /** Updates the row whose identifier matches `value`, only where `access` and `guard` both hold. */
  readonly update: RepositoryUpdate
  readonly remove: (
    table: Table,
    key: unknown,
    access: RepositoryAccess,
  ) => Effect.Effect<boolean, RepositoryError>
  /** One database transaction; nests as a savepoint inside an enclosing transaction. */
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | RepositoryError, R>
}>()("@effect-domains/RepositoryStore") {}
