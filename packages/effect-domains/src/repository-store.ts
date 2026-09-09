import { Context, Effect, Option, Schema } from "effect"
import { Policy } from "./policy.ts"
import type { Table } from "./table.ts"

const RepositoryListDirectionSchema = Schema.Literals(["asc", "desc"])
const RepositoryListCursorValuesSchema = Schema.Array(Schema.Unknown)
const RepositoryListQueryFilterSchema = Schema.Record(Schema.String, Schema.Unknown)
const RepositoryAccessSubjectSchema = Schema.Record(Schema.String, Schema.Unknown)

export class RepositoryListOrder extends Schema.Class<RepositoryListOrder>(
  "RepositoryListOrder",
)({
  field: Schema.String,
  direction: RepositoryListDirectionSchema,
}) {}

export class RepositoryListCursor extends Schema.Class<RepositoryListCursor>(
  "RepositoryListCursor",
)({
  values: RepositoryListCursorValuesSchema,
  identifier: Schema.Unknown,
}) {}

const RepositoryListQueryOrdersSchema = Schema.Array(RepositoryListOrder)
const RepositoryListQueryCursorSchema = Schema.Option(RepositoryListCursor)

export class RepositoryListQuery extends Schema.Class<RepositoryListQuery>(
  "RepositoryListQuery",
)({
  filter: RepositoryListQueryFilterSchema,
  order: RepositoryListQueryOrdersSchema,
  cursor: RepositoryListQueryCursorSchema,
  limit: Schema.Number,
}) {}

export class RepositoryAccess extends Schema.Class<RepositoryAccess>(
  "RepositoryAccess",
)({
  policy: Policy.Schema,
  subject: RepositoryAccessSubjectSchema,
}) {}

interface RepositoryListPage {
  readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>
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
  readonly find: (
    table: Table,
    key: unknown,
    access: RepositoryAccess,
  ) => Effect.Effect<Option.Option<unknown>, RepositoryError>
  readonly list: (
    table: Table,
    access: RepositoryAccess,
  ) => Effect.Effect<ReadonlyArray<unknown>, RepositoryError>
  readonly query: (
    table: Table,
    query: RepositoryListQuery,
    access: RepositoryAccess,
  ) => Effect.Effect<RepositoryListPage, RepositoryError>
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
