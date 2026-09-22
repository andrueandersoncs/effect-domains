import { Context, Effect, Schema } from "effect"
import type { TableSnapshot } from "./table.ts"


export class MigrationError extends Schema.TaggedError<MigrationError>()(
  "MigrationError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason
  }
}

export class SchemaStore extends Context.Service<SchemaStore, {
  readonly prepare: (
    tables: ReadonlyArray<TableSnapshot>,
  ) => Effect.Effect<void, MigrationError>
}>()("@effect-domains/SchemaStore") {}
